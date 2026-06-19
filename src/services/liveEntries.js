const DEFAULT_API_BASE_URL = "https://v3.football.api-sports.io";
const DEFAULT_SOFASCORE_BASE_URL = "https://www.sofascore.com/api/v1";
const DEFAULT_SOFASCORE_PUBLIC_URL = "https://www.sofascore.com/pt/futebol/";
const BETANO_TODAY_URL = "https://www.betano.bet.br/sport/futebol/jogos-de-hoje/";
const DEFAULT_CACHE_MS = 30000;
const DEFAULT_MAX_FIXTURES = 8;
const DEFAULT_API_TIMEOUT_MS = 8000;
const IGNORED_COMPETITIONS = new Set(["club friendly games mundo"]);

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
  const provider = String(process.env.LIVE_ENTRIES_PROVIDER || "auto").toLowerCase();
  let fallbackReason = null;
  if (provider === "sofascore" || provider === "auto") {
    try {
      const matches = await fetchSofaScoreLiveMatches();
      setCache("sofascore", matches, null);
      return snapshot();
    } catch (error) {
      if (provider === "sofascore") {
        setCache("simulator", buildDemoMatches(), `SofaScore indisponivel: ${error.message}. Exibindo dados de demonstracao.`);
        return snapshot();
      }
      fallbackReason = `SofaScore indisponivel: ${error.message}.`;
    }
  }

  const apiKey = process.env.API_FOOTBALL_KEY || process.env.APISPORTS_KEY;
  if ((provider === "api_football" || provider === "auto") && apiKey) {
    try {
      const matches = await fetchApiFootballLiveMatches(apiKey);
      setCache("api_football", matches, null);
      return snapshot();
    } catch (error) {
      setCache("simulator", buildDemoMatches(), `API-Football indisponivel: ${error.message}. Exibindo dados de demonstracao.`);
      return snapshot();
    }
  }

  setCache(
    "simulator",
    buildDemoMatches(),
    `${fallbackReason ? `${fallbackReason} ` : ""}API_FOOTBALL_KEY nao configurada. Exibindo dados de demonstracao.`
  );
  return snapshot();
}

async function fetchSofaScoreLiveMatches() {
  const baseUrl = String(process.env.SOFASCORE_BASE_URL || DEFAULT_SOFASCORE_BASE_URL).replace(/\/$/, "");
  const payload = await sofaScoreGet(baseUrl, "/sport/football/events/live");
  const events = Array.isArray(payload.events) ? payload.events : [];
  const limit = Math.max(1, Math.min(30, Number(process.env.LIVE_ENTRIES_MAX_FIXTURES || DEFAULT_MAX_FIXTURES)));
  const limited = events.slice(0, limit);
  const settled = await Promise.allSettled(limited.map((event) => buildSofaScoreMatch(baseUrl, event)));
  return settled
    .filter((result) => result.status === "fulfilled" && result.value)
    .map((result) => result.value);
}

async function buildSofaScoreMatch(baseUrl, event) {
  const eventId = event.id;
  const stats = eventId ? await fetchSofaScoreStatistics(baseUrl, eventId) : emptyStats();
  const minute = Number(event.time?.currentPeriodStartTimestamp
    ? Math.max(1, Math.floor((Date.now() / 1000 - Number(event.time.currentPeriodStartTimestamp)) / 60))
    : event.statusTime?.prefix ? Number(String(event.statusTime.prefix).replace(/\D/g, "")) : 0);
  const homeScore = Number(event.homeScore?.current || 0);
  const awayScore = Number(event.awayScore?.current || 0);

  return buildMatch({
    id: `sofa-${eventId || `${event.homeTeam?.name}-${event.awayTeam?.name}`}`,
    league: event.tournament?.name || event.tournament?.category?.name || "Campeonato",
    homeTeam: event.homeTeam?.name || "Mandante",
    awayTeam: event.awayTeam?.name || "Visitante",
    minute,
    homeScore,
    awayScore,
    liveOdd: estimateOver15Odd(minute, homeScore + awayScore),
    stats,
    startsAt: event.startTimestamp ? new Date(Number(event.startTimestamp) * 1000).toISOString() : new Date().toISOString(),
    source: "sofascore"
  });
}

async function fetchSofaScoreStatistics(baseUrl, eventId) {
  try {
    const payload = await sofaScoreGet(baseUrl, `/event/${eventId}/statistics`);
    const stats = emptyStats({ estimated: false, unavailable: false, source: "sofascore_statistics" });
    const groups = Array.isArray(payload.statistics) ? payload.statistics : [];
    groups.forEach((group) => {
      (group.groups || []).forEach((statsGroup) => {
        (statsGroup.statisticsItems || []).forEach((item) => {
          const name = normalizeText(item.name);
          const home = numberValue(item.home);
          const away = numberValue(item.away);
          const total = home + away;
          if (name.includes("total shots") || name.includes("shots")) stats.totalShots += total;
          if (name.includes("shots on target")) stats.shotsOnTarget += total;
          if (name.includes("corner")) stats.corners += total;
          if (name.includes("yellow")) stats.yellowCards += total;
          if (name.includes("red")) stats.redCards += total;
          if (name.includes("dangerous attacks")) stats.dangerousAttacks += total;
          if (name.includes("ball possession")) stats.possessionHome = home || stats.possessionHome;
        });
      });
    });
    if (!stats.dangerousAttacks) stats.dangerousAttacks = Math.round(stats.totalShots * 2.2 + stats.corners * 2);
    return stats;
  } catch {
    return emptyStats();
  }
}

async function sofaScoreGet(baseUrl, path) {
  const timeoutMs = Math.max(3000, Number(process.env.LIVE_ENTRIES_API_TIMEOUT_MS || DEFAULT_API_TIMEOUT_MS));
  const response = await fetch(`${baseUrl}${path}`, {
    headers: {
      "accept": "application/json,text/plain,*/*",
      "accept-language": "pt-BR,pt;q=0.9,en;q=0.8",
      "referer": "https://www.sofascore.com/football/livescore",
      "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36"
    },
    signal: AbortSignal.timeout(timeoutMs)
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
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
    const stats = emptyStats({ estimated: false, unavailable: false, source: "api_football_statistics" });
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
  const statsUnavailable = Boolean(stats.estimated || stats.unavailable);
  const pressure = statsUnavailable ? "sem estatisticas reais" : pressureLabel(stats.possessionHome);
  const score = liveFunnelScore({
    minute: input.minute,
    homeScore: input.homeScore,
    awayScore: input.awayScore,
    liveOdd: input.liveOdd,
    ...stats,
    pressure,
    statsUnavailable
  });
  const recommendation = buildEntryRecommendation(input, score);
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
    recommendation,
    reasons: score.reasons,
    stats,
    pressure,
    link: betanoEntryLink(input.league, input.homeTeam, input.awayTeam),
    source: input.source
  };
}

function buildEntryRecommendation(input, score) {
  const goals = Number(input.homeScore || 0) + Number(input.awayScore || 0);
  const goalsNeeded = Math.max(0, 2 - goals);
  const confidence = score.score >= 95 ? "Muito forte" : score.score >= 85 ? "Forte" : score.score >= 75 ? "Acompanhar" : "Baixa";
  const detail = goalsNeeded === 2
    ? "Precisa sair 2 gols na partida para bater a linha."
    : goalsNeeded === 1
      ? "Precisa sair mais 1 gol na partida para bater a linha."
      : "Linha ja batida. Nao abrir nova entrada pelo funil Over 1.5.";
  return {
    market: "Over 1.5 gols",
    action: "Conferir a odd do Over 1.5 gols antes de entrar",
    detail,
    goalsNeeded,
    confidence
  };
}

function liveFunnelScore(match) {
  let score = 0;
  const reasons = [];
  if (match.statsUnavailable) {
    reasons.push("estatisticas reais indisponiveis");
  }
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

  if (match.statsUnavailable) {
    score = Math.min(score, 45);
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
    providerLabel: cache.provider === "api_football" ? "API-Football" : cache.provider === "sofascore" ? "SofaScore" : "Demonstracao",
    isDemo: cache.provider === "simulator",
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

function dashboardFromSofaScoreSnapshot(snapshot) {
  if (!snapshot) return null;
  const matches = (snapshot.games || []).filter((game) => isSofaScoreLiveGame(game) && !isIgnoredCompetition(game)).map((game) => {
    const minute = Number(game.minute || 0) || minuteFromSofaScoreStatus(game.status) || minuteFromSofaScoreStatus(game.statusLabel);
    const homeScore = Number(game.homeScore ?? 0);
    const awayScore = Number(game.awayScore ?? 0);
    const match = buildMatch({
      id: `browser-sofa-${game.eventId || game.id}`,
      league: [game.competition, game.group].filter(Boolean).join(" - ") || "SofaScore",
      homeTeam: game.homeTeam,
      awayTeam: game.awayTeam,
      minute,
      homeScore,
      awayScore,
      liveOdd: game.liveOdd || estimateOver15Odd(minute, homeScore + awayScore),
      stats: game.stats || emptyStats(),
      startsAt: snapshot.finishedAt || game.capturedAt || new Date().toISOString(),
      source: "browser_sofascore"
    });
    match.status = sofaScoreDisplayStatus(game) || match.status;
    match.sofaScoreStatus = game.status || null;
    match.scoreboard = game.score || match.scoreboard;
    match.odds1x2 = game.odds1x2 || null;
    match.eventId = game.eventId || null;
    match.link = sofaScorePublicLink(game.href);
    match.statsEstimated = Boolean(match.stats?.estimated || match.stats?.unavailable || game.stats?.estimated || game.stats?.unavailable);
    return match;
  });
  const signals = matches
    .filter((match) => match.funnelScore >= 85 && !match.reasons.includes("placar fora da janela"))
    .sort((a, b) => b.funnelScore - a.funnelScore);
  return {
    updatedAt: snapshot.finishedAt || snapshot.createdAt,
    provider: "browser_sofascore",
    providerLabel: "SofaScore Browser",
    isDemo: false,
    betanoUrl: BETANO_TODAY_URL,
    error: snapshot.ok ? null : snapshot.error,
    matches: matches.slice().sort((a, b) => b.funnelScore - a.funnelScore),
    signals,
    stats: {
      matches: matches.length,
      live: matches.filter((match) => ["Ao vivo", "Intervalo"].includes(match.status)).length,
      signals: signals.length,
      bestScore: matches.reduce((highest, match) => Math.max(highest, match.funnelScore), 0)
    }
  };
}

function isSofaScoreLiveGame(game = {}) {
  const status = String(game.status || "").trim();
  const statusLabel = String(game.statusLabel || "").trim();
  if (["Ao vivo", "Intervalo"].includes(status)) return true;
  if (["Ao vivo", "Intervalo"].includes(statusLabel)) return true;
  if (minuteFromSofaScoreStatus(status) || minuteFromSofaScoreStatus(statusLabel)) return true;
  if (["HT", "INT"].includes(status.toUpperCase())) return true;
  if (/INPROGRESS|LIVE|1ST|2ND|FIRST HALF|SECOND HALF|1H|2H/i.test(`${status} ${statusLabel}`)) return true;
  return false;
}

function isIgnoredCompetition(game = {}) {
  const keys = [
    `${game.competition || ""} ${game.group || ""}`,
    game.league,
    game.rawText
  ].map(normalizeText);
  return keys.some((key) => IGNORED_COMPETITIONS.has(key) || key.includes("club friendly games mundo"));
}

function sofaScoreDisplayStatus(game = {}) {
  const status = String(game.status || "").trim();
  const statusLabel = String(game.statusLabel || "").trim();
  if (["Ao vivo", "Intervalo"].includes(status)) return status;
  if (["Ao vivo", "Intervalo", "Finalizado", "Agendado"].includes(statusLabel)) return statusLabel;
  if (minuteFromSofaScoreStatus(status) || minuteFromSofaScoreStatus(statusLabel)) return "Ao vivo";
  if (/INPROGRESS|LIVE|1ST|2ND|FIRST HALF|SECOND HALF|1H|2H/i.test(`${status} ${statusLabel}`)) return "Ao vivo";
  if (["HT", "INT"].includes(status.toUpperCase()) || ["HT", "INT"].includes(statusLabel.toUpperCase())) return "Intervalo";
  if (status.toUpperCase() === "FT" || statusLabel.toUpperCase() === "FT" || /FINISHED|ENDED|AFTER EXTRA|AFTER PEN/i.test(`${status} ${statusLabel}`)) return "Finalizado";
  if (!status || status === "-") return "Agendado";
  return statusLabel || status;
}

function minuteFromSofaScoreStatus(status) {
  const match = String(status || "").trim().match(/^(\d{1,3})(?:\+(\d{0,2}))?'?$/);
  if (!match) return 0;
  const minute = Number(match[1]) + Number(match[2] || 0);
  return minute > 0 && minute <= 130 ? minute : 0;
}

function sofaScorePublicLink(href) {
  const raw = String(href || "").trim();
  if (!raw) return DEFAULT_SOFASCORE_PUBLIC_URL;
  try {
    const url = new URL(raw);
    if (!/(^|\.)sofascore\.com$/i.test(url.hostname)) return DEFAULT_SOFASCORE_PUBLIC_URL;
    if (url.pathname === "/" || url.pathname === "/pt/" || !url.pathname) url.pathname = "/pt/futebol/";
    return url.toString();
  } catch {
    return DEFAULT_SOFASCORE_PUBLIC_URL;
  }
}

function emptyStats(extra = {}) {
  return {
    totalShots: 0,
    shotsOnTarget: 0,
    corners: 0,
    dangerousAttacks: 0,
    possessionHome: 50,
    yellowCards: 0,
    redCards: 0,
    estimated: true,
    unavailable: true,
    ...extra
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
  dashboardFromSofaScoreSnapshot,
  getLiveEntriesDashboard,
  isSofaScoreLiveGame,
  refreshLiveEntries
};
