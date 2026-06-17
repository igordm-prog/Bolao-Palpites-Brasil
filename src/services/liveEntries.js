const DEFAULT_API_BASE_URL = "https://v3.football.api-sports.io";
const BETANO_TODAY_URL = "https://www.betano.bet.br/sport/futebol/jogos-de-hoje/";
const DEFAULT_CACHE_MS = 30000;
const DEFAULT_MAX_FIXTURES = 8;
const DEFAULT_API_TIMEOUT_MS = 8000;

const leagueLinks = new Map([
  ["brasileirao serie a", "https://www.betano.bet.br/sport/futebol/brasil/brasileirao-serie-a-betano/10016/"],
  ["brasileirão série a", "https://www.betano.bet.br/sport/futebol/brasil/brasileirao-serie-a-betano/10016/"],
  ["copa do brasil", "https://www.betano.bet.br/sport/futebol/brasil/copa-betano-do-brasil/10008/"],
  ["la liga", "https://www.betano.bet.br/sport/futebol/espanha/laliga/5/"],
  ["laliga", "https://www.betano.bet.br/sport/futebol/espanha/laliga/5/"],
  ["premier league", "https://www.betano.bet.br/sport/futebol/competicoes/inglaterra/1/"],
  ["liga dos campeoes", "https://www.betano.bet.br/sport/futebol/competicoes/liga-dos-campeoes/188566/"],
  ["liga dos campeões", "https://www.betano.bet.br/sport/futebol/competicoes/liga-dos-campeoes/188566/"],
  ["copa libertadores", "https://www.betano.bet.br/sport/futebol/competicoes/copa-libertadores/189817/"]
]);

const demoGames = [
  ["Flamengo", "Bahia", "Brasileirao Serie A"],
  ["Palmeiras", "Fortaleza", "Brasileirao Serie A"],
  ["Cruzeiro", "Sport", "Brasileirao Serie B"],
  ["Santos", "Vitoria", "Brasileirao Serie B"],
  ["Arsenal", "Everton", "Premier League"],
  ["Barcelona", "Valencia", "La Liga"]
];

const cache = {
  updatedAt: null,
  provider: "simulator",
  matches: [],
  signals: [],
  error: null
};

function betanoEntryLink(league = "", homeTeam = "", awayTeam = "") {
  if (process.env.BETANO_ENTRY_URL) return process.env.BETANO_ENTRY_URL;
  const leagueKey = normalizeText(league);
  if (leagueLinks.has(leagueKey)) return leagueLinks.get(leagueKey);
  const query = encodeURIComponent([homeTeam, awayTeam].filter(Boolean).join(" "));
  return query ? `${BETANO_TODAY_URL}?q=${query}` : BETANO_TODAY_URL;
}

async function getLiveEntriesDashboard(options = {}) {
  const maxAgeMs = Number(options.maxAgeMs || process.env.LIVE_ENTRIES_CACHE_MS || DEFAULT_CACHE_MS);
  if (!cache.updatedAt || Date.now() - new Date(cache.updatedAt).getTime() > maxAgeMs) {
    await refreshLiveEntries();
  }
  return snapshot();
}

async function refreshLiveEntries() {
  const apiKey = process.env.API_FOOTBALL_KEY || process.env.APISPORTS_KEY;
  if (apiKey) {
    try {
      const matches = await fetchApiFootballLiveMatches(apiKey);
      setCache("api_football", matches, null);
      return snapshot();
    } catch (error) {
      setCache("simulator", buildDemoMatches(), `API-Football indisponivel: ${error.message}`);
      return snapshot();
    }
  }

  setCache("simulator", buildDemoMatches(), "API_FOOTBALL_KEY nao configurada. Exibindo dados de demonstracao.");
  return snapshot();
}

async function fetchApiFootballLiveMatches(apiKey) {
  const baseUrl = String(process.env.API_FOOTBALL_BASE_URL || DEFAULT_API_BASE_URL).replace(/\/$/, "");
  const payload = await apiGet(baseUrl, "/fixtures", { live: "all" }, apiKey);
  const fixtures = Array.isArray(payload.response) ? payload.response : [];
  const limit = Math.max(1, Math.min(30, Number(process.env.LIVE_ENTRIES_MAX_FIXTURES || DEFAULT_MAX_FIXTURES)));
  const limited = fixtures.slice(0, limit);
  const settled = await Promise.allSettled(limited.map((item) => buildApiFootballMatch(baseUrl, apiKey, item)));
  return settled
    .filter((result) => result.status === "fulfilled" && result.value)
    .map((result) => result.value);
}

async function buildApiFootballMatch(baseUrl, apiKey, item) {
  const fixtureId = item.fixture?.id;
  const league = item.league?.name || "Campeonato";
  const homeTeam = item.teams?.home?.name || "Mandante";
  const awayTeam = item.teams?.away?.name || "Visitante";
  const status = item.fixture?.status || {};
  const goals = item.goals || {};
  const minute = Number(status.elapsed || 0);
  const homeScore = Number(goals.home || 0);
  const awayScore = Number(goals.away || 0);
  const [stats, liveOdd] = fixtureId
    ? await Promise.all([
        fetchFixtureStatistics(baseUrl, fixtureId, apiKey),
        fetchLiveOver15Odd(baseUrl, fixtureId, apiKey)
      ])
    : [emptyStats(), null];

  return buildMatch({
    id: `api-${fixtureId || `${homeTeam}-${awayTeam}`}`,
    league,
    homeTeam,
    awayTeam,
    minute,
    homeScore,
    awayScore,
    liveOdd: liveOdd || estimateOver15Odd(minute, homeScore + awayScore),
    stats,
    startsAt: item.fixture?.date || new Date().toISOString(),
    source: "api_football"
  });
}

async function fetchFixtureStatistics(baseUrl, fixtureId, apiKey) {
  try {
    const payload = await apiGet(baseUrl, "/fixtures/statistics", { fixture: fixtureId }, apiKey);
    const stats = emptyStats();
    const teams = Array.isArray(payload.response) ? payload.response : [];
    teams.forEach((teamStats, teamIndex) => {
      (teamStats.statistics || []).forEach((item) => {
        const type = normalizeText(item.type);
        const value = numberValue(item.value);
        if (type === "total shots") stats.totalShots += value;
        if (type === "shots on goal") stats.shotsOnTarget += value;
        if (type === "corner kicks") stats.corners += value;
        if (type === "yellow cards") stats.yellowCards += value;
        if (type === "red cards") stats.redCards += value;
        if (type === "dangerous attacks" || type === "attacks") stats.dangerousAttacks += value;
        if (type === "ball possession" && teamIndex === 0) stats.possessionHome = value;
      });
    });
    if (!stats.dangerousAttacks) stats.dangerousAttacks = Math.round(stats.totalShots * 2.2 + stats.corners * 2);
    return stats;
  } catch {
    return emptyStats();
  }
}

async function fetchLiveOver15Odd(baseUrl, fixtureId, apiKey) {
  try {
    const payload = await apiGet(baseUrl, "/odds/live", { fixture: fixtureId }, apiKey);
    for (const item of payload.response || []) {
      for (const bet of item.odds || []) {
        const name = normalizeText(bet.name);
        if (!name.includes("over") && !name.includes("goals")) continue;
        for (const value of bet.values || []) {
          const label = normalizeText(value.value);
          const handicap = String(value.handicap || "");
          if ((label.includes("over") && label.includes("1.5")) || handicap === "1.5") {
            const odd = Number(value.odd);
            if (Number.isFinite(odd) && odd > 1) return odd;
          }
        }
      }
    }
  } catch {
    return null;
  }
  return null;
}

async function apiGet(baseUrl, path, params, apiKey) {
  const url = new URL(`${baseUrl}${path}`);
  Object.entries(params).forEach(([key, value]) => url.searchParams.set(key, value));
  const timeoutMs = Math.max(3000, Number(process.env.LIVE_ENTRIES_API_TIMEOUT_MS || DEFAULT_API_TIMEOUT_MS));
  const response = await fetch(url, {
    headers: { "x-apisports-key": apiKey },
    signal: AbortSignal.timeout(timeoutMs)
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

function buildDemoMatches() {
  const now = new Date();
  return demoGames.map(([homeTeam, awayTeam, league], index) => {
    const minute = 14 + index * 4 + Math.floor((Date.now() / 30000 + index) % 4);
    const homeScore = index === 4 ? 1 : 0;
    const awayScore = 0;
    const stats = {
      totalShots: 4 + index + Math.floor((Date.now() / 20000 + index) % 4),
      shotsOnTarget: 1 + (index % 3),
      corners: 2 + (index % 4),
      dangerousAttacks: 15 + index * 3,
      possessionHome: 50 + index * 3,
      yellowCards: index % 2,
      redCards: 0
    };
    return buildMatch({
      id: `demo-${index + 1}`,
      league,
      homeTeam,
      awayTeam,
      minute,
      homeScore,
      awayScore,
      liveOdd: estimateOver15Odd(minute, homeScore + awayScore),
      stats,
      startsAt: new Date(now.getTime() + (index - 2) * 12 * 60000).toISOString(),
      source: "simulator"
    });
  });
}

function buildMatch(input) {
  const stats = { ...emptyStats(), ...input.stats };
  const pressure = pressureLabel(stats.possessionHome);
  const score = liveFunnelScore({
    minute: input.minute,
    homeScore: input.homeScore,
    awayScore: input.awayScore,
    liveOdd: input.liveOdd,
    ...stats,
    pressure
  });
  return {
    id: input.id,
    league: input.league,
    homeTeam: input.homeTeam,
    awayTeam: input.awayTeam,
    startsAt: input.startsAt,
    status: score.score >= 85 ? "Entrada encontrada" : score.score >= 60 ? "Em observacao" : "Ao vivo",
    minute: input.minute,
    scoreboard: `${input.homeScore} x ${input.awayScore}`,
    liveOdd: Number(input.liveOdd || 0).toFixed(2),
    funnelScore: score.score,
    classification: score.classification,
    reasons: score.reasons,
    stats,
    pressure,
    link: betanoEntryLink(input.league, input.homeTeam, input.awayTeam),
    source: input.source
  };
}

function liveFunnelScore(match) {
  let score = 0;
  const reasons = [];
  if (match.minute >= 15 && match.minute <= 35) {
    score += 10;
    reasons.push("minuto ideal");
  }
  if (match.liveOdd >= 1.7 && match.liveOdd <= 2.2) {
    score += 15;
    reasons.push("odd dentro do filtro");
  }
  if (match.totalShots >= 6) {
    score += 15;
    reasons.push(`${match.totalShots} finalizacoes`);
  }
  if (match.shotsOnTarget >= 2) {
    score += 20;
    reasons.push(`${match.shotsOnTarget} no alvo`);
  }
  if (match.corners >= 3) {
    score += 10;
    reasons.push(`${match.corners} escanteios`);
  }
  if (["favorito pressionando", "mandante pressionando", "visitante pressionando"].includes(match.pressure)) {
    score += 15;
    reasons.push(match.pressure);
  }
  if (match.dangerousAttacks >= 18) {
    score += 15;
    reasons.push("ataques perigosos");
  }
  if (match.redCards === 0) {
    score += 10;
    reasons.push("sem vermelho");
  }

  if (match.homeScore + match.awayScore > 1) {
    reasons.push("placar fora da janela");
  }

  const classification = score >= 85 ? "entrada encontrada" : score >= 75 ? "possivel entrada" : score >= 60 ? "observar" : "sem entrada";
  return { score, classification, reasons };
}

function setCache(provider, matches, error) {
  cache.updatedAt = new Date().toISOString();
  cache.provider = provider;
  cache.matches = matches;
  cache.signals = matches.filter((match) => match.funnelScore >= 85 && !match.reasons.includes("placar fora da janela"));
  cache.error = error;
}

function snapshot() {
  const matches = cache.matches.slice().sort((a, b) => b.funnelScore - a.funnelScore);
  const signals = cache.signals.slice().sort((a, b) => b.funnelScore - a.funnelScore);
  return {
    updatedAt: cache.updatedAt,
    provider: cache.provider,
    providerLabel: cache.provider === "api_football" ? "API-Football" : "Demonstracao",
    isDemo: cache.provider !== "api_football",
    betanoUrl: BETANO_TODAY_URL,
    error: cache.error,
    matches,
    signals,
    stats: {
      matches: matches.length,
      live: matches.filter((match) => match.status !== "Finalizado").length,
      signals: signals.length,
      bestScore: matches.reduce((highest, match) => Math.max(highest, match.funnelScore), 0)
    }
  };
}

function emptyStats() {
  return {
    totalShots: 0,
    shotsOnTarget: 0,
    corners: 0,
    dangerousAttacks: 0,
    possessionHome: 50,
    yellowCards: 0,
    redCards: 0
  };
}

function pressureLabel(possessionHome) {
  if (possessionHome >= 57) return "favorito pressionando";
  if (possessionHome <= 43) return "visitante pressionando";
  return "ritmo ofensivo";
}

function estimateOver15Odd(minute, goals) {
  const odd = 2.35 - minute * 0.018 - goals * 0.42;
  return Math.max(1.2, Math.min(2.75, odd));
}

function numberValue(value) {
  if (value === null || value === undefined) return 0;
  const parsed = Number(String(value).replace("%", "").trim());
  return Number.isFinite(parsed) ? Math.round(parsed) : 0;
}

function normalizeText(value = "") {
  return String(value)
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim();
}

module.exports = {
  betanoEntryLink,
  getLiveEntriesDashboard,
  refreshLiveEntries
};
