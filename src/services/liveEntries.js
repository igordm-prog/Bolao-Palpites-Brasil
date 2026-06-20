const DEFAULT_API_BASE_URL = "https://v3.football.api-sports.io";
const DEFAULT_SOFASCORE_BASE_URL = "https://www.sofascore.com/api/v1";
const DEFAULT_SOFASCORE_PUBLIC_URL = "https://www.sofascore.com/pt/futebol/";
const DEFAULT_CACHE_MS = 30000;
const DEFAULT_MAX_FIXTURES = 8;
const DEFAULT_API_TIMEOUT_MS = 8000;
const IGNORED_COMPETITIONS = new Set(["club friendly games mundo", "club friendly games world"]);
const ALERT_COOLDOWN_MS = 5 * 60 * 1000;
const alertCooldowns = new Map();

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
          if (name.includes("expected goals") || name.includes("gols esperados") || name === "xg") {
            stats.expectedGoalsHome += decimalValue(item.home);
            stats.expectedGoalsAway += decimalValue(item.away);
            stats.expectedGoals += decimalValue(item.home) + decimalValue(item.away);
          }
          if (name.includes("total shots") || name.includes("shots")) {
            stats.homeTotalShots += home;
            stats.awayTotalShots += away;
            stats.totalShots += total;
          }
          if (name.includes("shots on target")) {
            stats.homeShotsOnTarget += home;
            stats.awayShotsOnTarget += away;
            stats.shotsOnTarget += total;
          }
          if (name.includes("corner")) {
            stats.homeCorners += home;
            stats.awayCorners += away;
            stats.corners += total;
          }
          if (name.includes("yellow")) stats.yellowCards += total;
          if (name.includes("red")) stats.redCards += total;
          if (name.includes("dangerous attacks")) stats.dangerousAttacks += total;
          if (name.includes("ball possession")) {
            stats.possessionHome = home || stats.possessionHome;
            stats.possessionAway = away || stats.possessionAway;
          }
        });
      });
    });
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
  const stats = fixtureId ? await fetchFixtureStatistics(baseUrl, fixtureId, apiKey) : emptyStats();

  return buildMatch({
    id: `api-${fixtureId || `${homeTeam}-${awayTeam}`}`,
    league,
    homeTeam,
    awayTeam,
    minute,
    homeScore,
    awayScore,
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
    return stats;
  } catch {
    return emptyStats();
  }
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
      stats,
      startsAt: new Date(now.getTime() + (index - 2) * 12 * 60000).toISOString(),
      source: "simulator"
    });
  });
}

function buildMatch(input) {
  const stats = { ...emptyStats(), ...input.stats };
  const dados = normalizarEstatisticas({
    id: input.id,
    league: input.league,
    homeTeam: input.homeTeam,
    awayTeam: input.awayTeam,
    minute: input.minute,
    homeScore: input.homeScore,
    awayScore: input.awayScore,
    stats,
    startsAt: input.startsAt,
    source: input.source
  });
  const evaluations = [
    avaliarGolLimite1T(dados),
    avaliarGolLimite2T(dados),
    avaliarCantoLimite(dados)
  ].filter((result) => result.approved);
  const alert = evaluations[0] ? montarMensagemAlertaSemOdd(dados, evaluations[0]) : null;
  return {
    id: input.id,
    league: input.league,
    homeTeam: input.homeTeam,
    awayTeam: input.awayTeam,
    startsAt: input.startsAt,
    status: alert ? "Entrada encontrada" : "Ao vivo",
    minute: input.minute,
    scoreboard: `${input.homeScore} x ${input.awayScore}`,
    funnelScore: alert ? 100 : 0,
    classification: alert ? "entrada encontrada" : dados.decisionLog,
    recommendation: alert ? { market: alert.entrada, action: "Analisar manualmente", detail: alert.motivos.join(" "), confidence: "Alerta" } : null,
    reasons: alert ? alert.motivos : dados.missingReasons,
    alert,
    alerts: evaluations.map((result) => montarMensagemAlertaSemOdd(dados, result)),
    stats,
    statsEstimated: Boolean(stats.estimated || stats.unavailable),
    pressure: dados.pressure,
    link: input.link || DEFAULT_SOFASCORE_PUBLIC_URL,
    source: input.source
  };
}

function normalizarEstatisticas(jogo = {}) {
  const stats = { ...emptyStats(), ...(jogo.stats || {}) };
  const minute = Number(jogo.minute || 0);
  const period = minute > 45 ? 2 : 1;
  const appm = calcularAPPM(stats.dangerousAttacks, minute);
  const cg = calcularCG(stats.totalShots, stats.shotsOnTarget, stats.corners);
  const possessionHome = Number(stats.possessionHome || 50);
  const possessionAway = Number(stats.possessionAway || (possessionHome ? 100 - possessionHome : 50));
  const dominantPossession = Math.max(possessionHome, possessionAway);
  const xg = Number(stats.expectedGoals || 0);
  const missingReasons = [];
  if (!minute || minute > 120) missingReasons.push("tempo de jogo sem confiabilidade");
  if (stats.estimated || stats.unavailable) missingReasons.push("estatisticas reais indisponiveis");
  if (!stats.dangerousAttacks) missingReasons.push("ataques perigosos ausentes");
  if (!stats.totalShots && !stats.corners) missingReasons.push("chances de gol ausentes");
  if (!xg) missingReasons.push("xG ausente");
  const favoriteSide = inferFavoriteSide(stats);
  return {
    id: jogo.id,
    gameId: jogo.id,
    league: jogo.league,
    homeTeam: jogo.homeTeam,
    awayTeam: jogo.awayTeam,
    minute,
    period,
    periodLabel: period === 1 ? "1oT" : "2oT",
    homeScore: Number(jogo.homeScore || 0),
    awayScore: Number(jogo.awayScore || 0),
    stats,
    appm,
    cg,
    possessionHome,
    possessionAway,
    dominantPossession,
    xg,
    corners: Number(stats.corners || 0),
    favoriteSide,
    favoriteIsDrawingOrLosing: favoriteSide === "home"
      ? Number(jogo.homeScore || 0) <= Number(jogo.awayScore || 0)
      : Number(jogo.awayScore || 0) <= Number(jogo.homeScore || 0),
    pressure: dominantPossession >= 60 ? "Favorito pressionando no campo de ataque" : "Monitorando ritmo",
    missingReasons,
    decisionLog: missingReasons.length ? missingReasons.join("; ") : "monitorando"
  };
}

function calcularAPPM(ataquesPerigosos, minutoAtual) {
  const minute = Number(minutoAtual || 0);
  if (!minute) return 0;
  return Math.round((Number(ataquesPerigosos || 0) / minute) * 100) / 100;
}

function calcularCG(finalizacoes, chutesAoAlvo, escanteios) {
  const shots = Number(finalizacoes || 0);
  const target = Number(chutesAoAlvo || 0);
  const corners = Number(escanteios || 0);
  return target > 0 ? shots + target + corners : shots + corners;
}

function avaliarGolLimite1T(dados, config = {}) {
  const cfg = { appm: 1, cg: 10, possession: 60, xg: 1, corners: 3, ...config };
  return evaluateRequiredFunnel(dados, "Gol Limite 1o Tempo", [
    [dados.period === 1, "periodo precisa ser 1o tempo"],
    [dados.appm >= cfg.appm, "APPM abaixo de 1.00"],
    [dados.cg >= cfg.cg, "chances de gol abaixo de 10"],
    [dados.dominantPossession >= cfg.possession, "posse de bola abaixo de 60%"],
    [dados.xg >= cfg.xg, "xG abaixo de 1.00"],
    [dados.corners >= cfg.corners, "tendencia de escanteios abaixo de 3"]
  ]);
}

function avaliarGolLimite2T(dados, config = {}) {
  const cfg = { appm: 1, cg: 15, possession: 60, xg: 1, corners: 7, ...config };
  return evaluateRequiredFunnel(dados, "Gol Limite 2o Tempo", [
    [dados.period === 2, "periodo precisa ser 2o tempo"],
    [dados.appm >= cfg.appm, "APPM abaixo de 1.00"],
    [dados.cg >= cfg.cg, "chances de gol abaixo de 15"],
    [dados.dominantPossession >= cfg.possession, "posse de bola abaixo de 60%"],
    [dados.xg >= cfg.xg, "xG abaixo de 1.00"],
    [dados.corners >= cfg.corners, "tendencia de escanteios abaixo de 7"]
  ]);
}

function avaliarCantoLimite(dados, config = {}) {
  const cfg = { appm: 1, cg1: 10, cg2: 15, possession: 56, xg: 1, ...config };
  const cgOk = dados.period === 1 ? dados.cg > cfg.cg1 : dados.cg > cfg.cg2;
  return evaluateRequiredFunnel(dados, "Canto Limite", [
    [validarJanelaCantoLimite(dados.period, dados.minute), "fora da janela de entrada do Canto Limite"],
    [dados.appm >= cfg.appm, "APPM abaixo de 1.00"],
    [cgOk, "chances de gol abaixo do minimo por periodo"],
    [dados.xg > cfg.xg, "xG abaixo ou igual a 1.00"],
    [dados.dominantPossession > cfg.possession, "posse de bola abaixo ou igual a 56%"],
    [dados.favoriteIsDrawingOrLosing, "favorito nao esta empatando ou perdendo"]
  ]);
}

function validarJanelaCantoLimite(periodo, minuto) {
  const minute = Number(minuto || 0);
  if (Number(periodo) === 1) return minute >= 37 && minute <= 42;
  if (Number(periodo) === 2) return minute >= 85 && minute <= 88;
  return false;
}

function evaluateRequiredFunnel(dados, entrada, rules) {
  if (dados.missingReasons.length) return { approved: false, entrada, rejected: dados.missingReasons };
  const rejected = rules.filter(([approved]) => !approved).map(([, reason]) => reason);
  return {
    approved: rejected.length === 0,
    entrada,
    rejected,
    motivos: rejected.length ? [] : montarMotivos(dados, entrada)
  };
}

function montarMotivos(dados) {
  return [
    `APPM: ${dados.appm.toFixed(2)}, acima do minimo de 1.00.`,
    `Chances de gol: ${dados.cg}, acima do minimo exigido.`,
    `Posse de bola: ${dados.dominantPossession}%, acima do filtro.`,
    `xG: ${dados.xg.toFixed(2)}, acima do minimo exigido.`,
    `Tendencia de escanteios dentro do filtro (${dados.corners}).`,
    dados.pressure
  ];
}

function montarMensagemAlertaSemOdd(dados, resultado) {
  const chave = `${dados.gameId}:${dados.period}:${resultado.entrada}`;
  return {
    title: "Entrada encontrada",
    entrada: resultado.entrada,
    gameId: dados.gameId,
    key: chave,
    jogo: `${dados.homeTeam} x ${dados.awayTeam}`,
    campeonato: dados.league,
    tempo: `${dados.minute}' ${dados.periodLabel}`,
    motivos: resultado.motivos || montarMotivos(dados),
    text: [
      "Entrada encontrada",
      "",
      `Entrada: ${resultado.entrada}`,
      `Jogo: ${dados.homeTeam} x ${dados.awayTeam}`,
      `Campeonato: ${dados.league}`,
      `Tempo: ${dados.minute}' ${dados.periodLabel}`,
      "",
      "Motivo:",
      ...(resultado.motivos || montarMotivos(dados)).map((motivo) => `- ${motivo}`)
    ].join("\n")
  };
}

function verificarCooldown(chaveAlerta, now = Date.now()) {
  const last = alertCooldowns.get(chaveAlerta) || 0;
  if (now - last < ALERT_COOLDOWN_MS) return false;
  alertCooldowns.set(chaveAlerta, now);
  return true;
}

function enviarAlertaWhatsAppOuTelegram(alerta) {
  return { sent: false, alerta };
}

function registrarLogDeDecisao(dados, resultado) {
  return { gameId: dados.gameId, entrada: resultado.entrada, approved: resultado.approved, rejected: resultado.rejected || [] };
}

function inferFavoriteSide(stats = {}) {
  const homePressure =
    Number(stats.possessionHome || 0) +
    Number(stats.expectedGoalsHome || 0) * 20 +
    Number(stats.homeTotalShots || 0) +
    Number(stats.homeShotsOnTarget || 0) * 2 +
    Number(stats.homeCorners || 0);
  const awayPressure =
    Number(stats.possessionAway || 0) +
    Number(stats.expectedGoalsAway || 0) * 20 +
    Number(stats.awayTotalShots || 0) +
    Number(stats.awayShotsOnTarget || 0) * 2 +
    Number(stats.awayCorners || 0);
  return homePressure >= awayPressure ? "home" : "away";
}

function setCache(provider, matches, error) {
  cache.updatedAt = new Date().toISOString();
  cache.provider = provider;
  cache.matches = matches;
  cache.signals = matches.filter((match) => match.alert);
  cache.error = error;
}

function snapshot() {
  const matches = cache.matches.slice().sort((a, b) => Number(b.alert ? 1 : 0) - Number(a.alert ? 1 : 0));
  const signals = cache.signals.slice();
  return {
    updatedAt: cache.updatedAt,
    provider: cache.provider,
    providerLabel: cache.provider === "api_football" ? "API-Football" : cache.provider === "sofascore" ? "SofaScore" : "Demonstracao",
    isDemo: cache.provider === "simulator",
    error: cache.error,
    matches,
    signals,
    stats: {
      matches: matches.length,
      live: matches.filter((match) => match.status !== "Finalizado").length,
      signals: signals.length,
      withStats: matches.filter((match) => !match.statsEstimated).length
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
      stats: game.stats || emptyStats(),
      startsAt: snapshot.finishedAt || game.capturedAt || new Date().toISOString(),
      source: "browser_sofascore",
      link: sofaScorePublicLink(game.href, game)
    });
    match.status = sofaScoreDisplayStatus(game) || match.status;
    match.sofaScoreStatus = game.status || null;
    match.scoreboard = game.score || match.scoreboard;
    match.eventId = game.eventId || null;
    match.statsEstimated = Boolean(match.stats?.estimated || match.stats?.unavailable || game.stats?.estimated || game.stats?.unavailable);
    return match;
  });
  const signals = matches.filter((match) => match.alert);
  return {
    updatedAt: snapshot.finishedAt || snapshot.createdAt,
    provider: "browser_sofascore",
    providerLabel: "SofaScore Browser",
    isDemo: false,
    error: snapshot.ok ? null : snapshot.error,
    matches: matches.slice().sort((a, b) => Number(b.alert ? 1 : 0) - Number(a.alert ? 1 : 0)),
    signals,
    stats: {
      matches: matches.length,
      live: matches.filter((match) => ["Ao vivo", "Intervalo"].includes(match.status)).length,
      signals: signals.length,
      withStats: matches.filter((match) => !match.statsEstimated).length
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
  return keys.some((key) => IGNORED_COMPETITIONS.has(key) || key.includes("club friendly games mundo") || key.includes("club friendly games world"));
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

function sofaScorePublicLink(href, game = {}) {
  const raw = String(href || "").trim();
  if (!raw) return DEFAULT_SOFASCORE_PUBLIC_URL;
  try {
    const url = new URL(raw);
    if (!/(^|\.)sofascore\.com$/i.test(url.hostname)) return DEFAULT_SOFASCORE_PUBLIC_URL;
    const customId = String(game.customId || "").trim();
    if (customId && /\/football\/match\/[^/]+\/?$/i.test(url.pathname)) {
      url.pathname = `${url.pathname.replace(/\/$/, "")}/${customId}`;
    }
    if (url.pathname === "/" || url.pathname === "/pt/" || !url.pathname) url.pathname = "/pt/futebol/";
    return url.toString();
  } catch {
    return DEFAULT_SOFASCORE_PUBLIC_URL;
  }
}

function emptyStats(extra = {}) {
  return {
    totalShots: 0,
    homeTotalShots: 0,
    awayTotalShots: 0,
    shotsOnTarget: 0,
    homeShotsOnTarget: 0,
    awayShotsOnTarget: 0,
    corners: 0,
    homeCorners: 0,
    awayCorners: 0,
    dangerousAttacks: 0,
    possessionHome: 50,
    possessionAway: 50,
    expectedGoals: 0,
    expectedGoalsHome: 0,
    expectedGoalsAway: 0,
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

function numberValue(value) {
  if (value === null || value === undefined) return 0;
  const parsed = Number(String(value).replace("%", "").trim());
  return Number.isFinite(parsed) ? Math.round(parsed) : 0;
}

function decimalValue(value) {
  if (value === null || value === undefined) return 0;
  const parsed = Number(String(value).replace("%", "").replace(",", ".").trim());
  return Number.isFinite(parsed) ? Math.round(parsed * 100) / 100 : 0;
}

function normalizeText(value = "") {
  return String(value)
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim();
}

module.exports = {
  dashboardFromSofaScoreSnapshot,
  getLiveEntriesDashboard,
  isSofaScoreLiveGame,
  refreshLiveEntries,
  __private: {
    normalizarEstatisticas,
    calcularAPPM,
    calcularCG,
    avaliarGolLimite1T,
    avaliarGolLimite2T,
    avaliarCantoLimite,
    validarJanelaCantoLimite,
    montarMotivos,
    montarMensagemAlertaSemOdd,
    verificarCooldown,
    registrarLogDeDecisao
  }
};
