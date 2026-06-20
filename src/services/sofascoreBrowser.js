const DEFAULT_SOFASCORE_URL = "https://www.sofascore.com/pt/futebol/";
const DEFAULT_TIMEOUT_MS = 30000;
const DEFAULT_SETTLE_MS = 5000;
const DEFAULT_CAPTURE_DELAY_MS = 1000;
const DEFAULT_MAX_CAPTURE_STEPS = 80;
const DEFAULT_MAX_EMPTY_CAPTURE_STEPS = 8;
const IGNORED_COMPETITIONS = new Set(["club friendly games mundo"]);

function normalizeLine(value = "") {
  return String(value).replace(/\s+/g, " ").trim();
}

function normalizeKey(value = "") {
  return normalizeLine(value)
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function onlyNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(String(value).replace(",", "."));
  return Number.isFinite(parsed) ? parsed : null;
}

function isMinuteStatus(value, options = {}) {
  const normalized = normalizeLine(value);
  if (options.allowPlain) return /^\d{1,3}(\+\d{0,2})?'?$/.test(normalized);
  return /^\d{1,3}(\+\d{0,2})'$/.test(normalized);
}

function minuteValue(status, options = {}) {
  const normalized = normalizeLine(status);
  const allowPlain = Boolean(options.allowPlain);
  const pattern = allowPlain ? /^(\d{1,3})(?:\+(\d{0,2}))?'?$/ : /^(\d{1,3})(?:\+(\d{0,2}))'$/;
  const match = normalized.match(pattern);
  if (!match) return 0;
  const minute = Number(match[1]) + Number(match[2] || 0);
  return minute > 0 && minute <= 130 ? minute : 0;
}

function normalizeCapturedStatus(status, source) {
  const normalized = normalizeLine(status || "-");
  if (!normalized) return "-";
  const minute = minuteValue(normalized, { allowPlain: true });
  if (minute && !normalized.includes("'") && source === "time_column") return `${normalized}'`;
  return normalized;
}

function likelyFootballLines(lines) {
  const ignored = new Set([
    "Sofascore",
    "Entrar",
    "Noticias",
    "Fantasy",
    "Torneio",
    "Mais",
    "Todos",
    "Casa",
    "Fora"
  ]);
  return lines
    .map(normalizeLine)
    .filter(Boolean)
    .filter((line) => !ignored.has(line))
    .filter((line) => line.length <= 90)
    .slice(0, 260);
}

function inferGamesFromLines(lines) {
  const games = [];
  const invalidTeams = new Set(["ENTRAR", "Em Tendencia", "Futebol", "Favoritos", "Competicoes", "Hoje"]);
  const isTime = (line) => /^(\d{1,2}:\d{2}|HT|FT|INT|\d{1,3}(?:\+\d{0,2})?'|Ao vivo)$/i.test(line);
  const isStatus = (line) => /^(-|HT|FT|INT|AET|PEN|\d{1,3}(?:\+\d{0,2})?'|Ao vivo)$/i.test(line);
  const isScore = (line) => /^\d{1,2}$/.test(line);
  const isTeam = (line) =>
    /^[\p{L}\d .,'&()-]{2,}$/u.test(line) &&
    !invalidTeams.has(line) &&
    !isTime(line) &&
    !isStatus(line) &&
    !isScore(line);

  for (let index = 0; index < lines.length - 3; index += 1) {
    const time = lines[index];
    const status = lines[index + 1];
    const homeTeam = lines[index + 2];
    const awayTeam = lines[index + 3];
    const homeScore = lines[index + 4];
    const awayScore = lines[index + 5];

    if (isTime(time) && isStatus(status) && isTeam(homeTeam) && isTeam(awayTeam)) {
      games.push({
        time,
        status,
        homeTeam,
        awayTeam,
        score: isScore(homeScore) && isScore(awayScore) ? `${homeScore} x ${awayScore}` : null
      });
      index += 3;
    }
  }
  return games.slice(0, 40);
}

function gameStatusLabel(status) {
  const normalized = normalizeLine(status);
  const upper = normalized.toUpperCase();
  if (!normalized || normalized === "-") return "Agendado";
  if (minuteValue(normalized, { allowPlain: true }) || upper === "AO VIVO") return "Ao vivo";
  if (/INPROGRESS|LIVE|1ST|2ND|FIRST HALF|SECOND HALF|1H|2H/i.test(normalized)) return "Ao vivo";
  if (upper === "HT" || upper === "INT" || upper === "INTERVALO") return "Intervalo";
  if (upper === "FT" || upper === "FINALIZADO" || /FINISHED|ENDED|AFTER EXTRA|AFTER PEN/i.test(normalized)) return "Finalizado";
  return normalized;
}

function minuteFromStatus(status) {
  return minuteValue(status, { allowPlain: true });
}

function hasLiveStatus(game = {}) {
  return ["Ao vivo", "Intervalo"].includes(gameStatusLabel(game.status || game.statusLabel || ""));
}

function isIgnoredCompetition(game = {}) {
  const keys = [
    `${game.competition || ""} ${game.group || ""}`,
    game.competition,
    game.league,
    game.rawText
  ].map(normalizeKey);
  return keys.some((key) => IGNORED_COMPETITIONS.has(key) || key.includes("club friendly games mundo"));
}

function isLiveSofaScoreEvent(event = {}) {
  const description = cleanValue(event.status?.description || event.status?.type || "");
  const statusTime = cleanValue(event.statusTime?.prefix || event.statusTime?.current || "");
  if (/finished|ended|after|notstarted|scheduled|postponed|canceled|cancelled/i.test(description)) return false;
  if (/half.?time|interval|intervalo|break/i.test(description)) return true;
  if (isMinuteStatus(statusTime, { allowPlain: true })) return true;
  const periodStart = Number(event.time?.currentPeriodStartTimestamp || 0);
  if (periodStart > 0) {
    const elapsedMinutes = Math.floor((Date.now() / 1000 - periodStart) / 60);
    if (elapsedMinutes > 0 && elapsedMinutes <= 130) return true;
  }
  if (/inprogress|live|ao vivo|1st|2nd|first half|second half|1h|2h/i.test(description)) return true;
  return false;
}

function emptyStats(extra = {}) {
  return {
    totalShots: 0,
    homeTotalShots: 0,
    awayTotalShots: 0,
    shotsOnTarget: 0,
    homeShotsOnTarget: 0,
    awayShotsOnTarget: 0,
    shotsOffTarget: 0,
    blockedShots: 0,
    corners: 0,
    homeCorners: 0,
    awayCorners: 0,
    dangerousAttacks: 0,
    attacks: 0,
    possessionHome: 50,
    possessionAway: 50,
    yellowCards: 0,
    redCards: 0,
    goalkeeperSaves: 0,
    fouls: 0,
    offsides: 0,
    bigChances: 0,
    expectedGoals: 0,
    expectedGoalsHome: 0,
    expectedGoalsAway: 0,
    statsItemsMapped: 0,
    estimated: true,
    unavailable: true,
    source: "unavailable",
    sourceDetail: null,
    ...extra
  };
}

function numberValue(value) {
  if (value === null || value === undefined || value === "") return 0;
  const parsed = Number(String(value).replace("%", "").replace(",", ".").trim());
  return Number.isFinite(parsed) ? Math.round(parsed) : 0;
}

function decimalValue(value) {
  if (value === null || value === undefined || value === "") return 0;
  const parsed = Number(String(value).replace("%", "").replace(",", ".").trim());
  return Number.isFinite(parsed) ? Math.round(parsed * 100) / 100 : 0;
}

function statSideValue(item = {}, side) {
  const candidates = side === "home"
    ? [item.homeValue, item.homeTotal, item.homeScore, item.home]
    : [item.awayValue, item.awayTotal, item.awayScore, item.away];
  return numberValue(candidates.find((value) => value !== null && value !== undefined && value !== ""));
}

function statSideDecimal(item = {}, side) {
  const candidates = side === "home"
    ? [item.homeValue, item.homeTotal, item.homeScore, item.home]
    : [item.awayValue, item.awayTotal, item.awayScore, item.away];
  return decimalValue(candidates.find((value) => value !== null && value !== undefined && value !== ""));
}

function collectStatisticItems(value, output = [], seen = new Set()) {
  if (!value || typeof value !== "object" || seen.has(value)) return output;
  seen.add(value);
  if (Array.isArray(value)) {
    value.forEach((item) => {
      if (item && typeof item === "object" && (item.name || item.key || item.title) && (
        item.home !== undefined ||
        item.away !== undefined ||
        item.homeValue !== undefined ||
        item.awayValue !== undefined
      )) {
        output.push(item);
      } else {
        collectStatisticItems(item, output, seen);
      }
    });
    return output;
  }
  Object.values(value).forEach((item) => collectStatisticItems(item, output, seen));
  return output;
}

function statisticsPayloadCandidates(payload = {}, sourceDetail = "sofascore_statistics") {
  if (!payload) return [];
  if (Array.isArray(payload)) {
    return payload.flatMap((item, index) =>
      statisticsPayloadCandidates(item?.json || item, item?.path || `${sourceDetail}[${index}]`)
    );
  }
  if (Array.isArray(payload.statistics) && payload.statistics.length) {
    return payload.statistics.map((period, index) => ({
      value: period,
      sourceDetail: [
        sourceDetail,
        period.period,
        period.periodName,
        period.groupName,
        `period-${index + 1}`
      ].filter(Boolean).join(":")
    }));
  }
  return [{ value: payload, sourceDetail }];
}

function addStatsPair(stats, totalKey, homeKey, awayKey, home, away) {
  stats[homeKey] = (stats[homeKey] || 0) + home;
  stats[awayKey] = (stats[awayKey] || 0) + away;
  stats[totalKey] = (stats[totalKey] || 0) + home + away;
}

function statsCandidateScore(stats = {}) {
  if (stats.unavailable) return 0;
  const base =
    stats.totalShots * 10 +
    stats.shotsOnTarget * 14 +
    stats.corners * 8 +
    stats.dangerousAttacks +
    stats.bigChances * 10 +
    stats.expectedGoals * 10 +
    stats.statsItemsMapped;
  const detail = normalizeKey(stats.sourceDetail || "");
  const periodBonus = /all|todos|total|match|partida/.test(detail) ? 10000 : 0;
  return periodBonus + base;
}

function parseSofaScoreStatisticsCandidate(candidate = {}) {
  const stats = emptyStats({
    estimated: false,
    unavailable: false,
    source: "sofascore_statistics",
    sourceDetail: candidate.sourceDetail || "sofascore_statistics"
  });
  let mappedItems = 0;
  const items = collectStatisticItems(candidate.value || {});
  items.forEach((item) => {
        const name = normalizeKey(item.name || item.key || item.title || "");
        const home = statSideValue(item, "home");
        const away = statSideValue(item, "away");
        const total = home + away;
        if (!name) return;

        if (name.includes("expected goals") || name.includes("gols esperados") || name === "xg" || name.includes(" xg")) {
          const homeDecimal = statSideDecimal(item, "home");
          const awayDecimal = statSideDecimal(item, "away");
          stats.expectedGoalsHome += homeDecimal;
          stats.expectedGoalsAway += awayDecimal;
          stats.expectedGoals += homeDecimal + awayDecimal;
          mappedItems += 1;
          return;
        }
        if (name.includes("big chances") || name.includes("grandes chances")) {
          stats.bigChances += total;
          mappedItems += 1;
          return;
        }
        if (name.includes("shots on target") || name.includes("on target") || name.includes("chutes no alvo") || name.includes("finalizacoes no alvo")) {
          addStatsPair(stats, "shotsOnTarget", "homeShotsOnTarget", "awayShotsOnTarget", home, away);
          mappedItems += 1;
          return;
        }
        if (name.includes("shots off target") || name.includes("off target") || name.includes("chutes para fora") || name.includes("finalizacoes para fora")) {
          stats.shotsOffTarget += total;
          mappedItems += 1;
          return;
        }
        if (name.includes("blocked shots") || name.includes("chutes bloqueados") || name.includes("finalizacoes bloqueadas")) {
          stats.blockedShots += total;
          mappedItems += 1;
          return;
        }
        if (name.includes("total shots") || name === "shots" || name.includes("shot attempts") || name.includes("finalizacoes") || name.includes("chutes")) {
          addStatsPair(stats, "totalShots", "homeTotalShots", "awayTotalShots", home, away);
          mappedItems += 1;
          return;
        }
        if (name.includes("corner") || name.includes("escanteio")) {
          addStatsPair(stats, "corners", "homeCorners", "awayCorners", home, away);
          mappedItems += 1;
          return;
        }
        if (name.includes("dangerous attacks") || name.includes("ataques perigosos")) {
          stats.dangerousAttacks += total;
          mappedItems += 1;
          return;
        }
        if (name === "attacks" || name.includes("ataques")) {
          stats.attacks += total;
          mappedItems += 1;
          return;
        }
        if (name.includes("goalkeeper saves") || name.includes("defesas do goleiro") || name.includes("defesas")) {
          stats.goalkeeperSaves += total;
          mappedItems += 1;
          return;
        }
        if (name.includes("fouls") || name.includes("faltas")) {
          stats.fouls += total;
          mappedItems += 1;
          return;
        }
        if (name.includes("offsides") || name.includes("impedimentos")) {
          stats.offsides += total;
          mappedItems += 1;
          return;
        }
        if (name.includes("yellow") || name.includes("amarelo")) {
          stats.yellowCards += total;
          mappedItems += 1;
          return;
        }
        if (name.includes("red") || name.includes("vermelho")) {
          stats.redCards += total;
          mappedItems += 1;
          return;
        }
        if (name.includes("ball possession") || name.includes("posse de bola")) {
          stats.possessionHome = home || stats.possessionHome;
          stats.possessionAway = away || (home ? 100 - home : stats.possessionAway);
          mappedItems += 1;
        }
  });

  if (!stats.dangerousAttacks && (stats.totalShots || stats.corners)) {
    stats.dangerousAttacks = Math.round(stats.totalShots * 2.2 + stats.corners * 2);
  }
  if (!stats.totalShots && (stats.shotsOnTarget || stats.shotsOffTarget || stats.blockedShots)) {
    stats.totalShots = stats.shotsOnTarget + stats.shotsOffTarget + stats.blockedShots;
  }
  stats.expectedGoals = Math.round(stats.expectedGoals * 100) / 100;
  stats.expectedGoalsHome = Math.round(stats.expectedGoalsHome * 100) / 100;
  stats.expectedGoalsAway = Math.round(stats.expectedGoalsAway * 100) / 100;
  stats.statsItemsMapped = mappedItems;

  return mappedItems ? stats : emptyStats();
}

function parseSofaScoreStatistics(payload = {}) {
  const candidates = statisticsPayloadCandidates(payload);
  const parsed = candidates
    .map(parseSofaScoreStatisticsCandidate)
    .filter((stats) => !stats.unavailable);
  if (!parsed.length) return emptyStats();
  return parsed.sort((a, b) => statsCandidateScore(b) - statsCandidateScore(a))[0];
}

function numberNearLabel(lines, labelPatterns) {
  const normalizedLines = lines.map((line) => normalizeLine(line));
  for (let index = 0; index < normalizedLines.length; index += 1) {
    const key = normalizeKey(normalizedLines[index]);
    if (!labelPatterns.some((pattern) => key.includes(pattern))) continue;
    const pairs = [
      [normalizedLines[index - 1], normalizedLines[index + 1]],
      [normalizedLines[index - 2], normalizedLines[index + 2]]
    ];
    for (const pair of pairs) {
      const values = pair
        .map((value) => onlyNumber(String(value || "").replace("%", "")))
        .filter((value) => value !== null && value >= 0);
      if (values.length >= 2) return values[0] + values[1];
    }
    const value = [normalizedLines[index - 1], normalizedLines[index + 1], normalizedLines[index - 2], normalizedLines[index + 2]]
      .map((item) => onlyNumber(String(item || "").replace("%", "")))
      .find((item) => item !== null && item >= 0);
    if (value !== undefined) return value;
  }
  return 0;
}

function decimalPairNearLabel(lines, labelPatterns) {
  const normalizedLines = lines.map((line) => normalizeLine(line));
  for (let index = 0; index < normalizedLines.length; index += 1) {
    const key = normalizeKey(normalizedLines[index]);
    if (!labelPatterns.some((pattern) => key.includes(pattern))) continue;
    const pairs = [
      [normalizedLines[index - 1], normalizedLines[index + 1]],
      [normalizedLines[index - 2], normalizedLines[index + 2]]
    ];
    for (const pair of pairs) {
      const values = pair
        .map((value) => onlyNumber(String(value || "").replace("%", "")))
        .filter((value) => value !== null && value >= 0);
      if (values.length >= 2) {
        return {
          home: Math.round(values[0] * 100) / 100,
          away: Math.round(values[1] * 100) / 100,
          total: Math.round((values[0] + values[1]) * 100) / 100
        };
      }
    }
  }
  return { home: 0, away: 0, total: 0 };
}

function sidePercentNearLabel(lines, labelPatterns) {
  const normalizedLines = lines.map((line) => normalizeLine(line));
  for (let index = 0; index < normalizedLines.length; index += 1) {
    const key = normalizeKey(normalizedLines[index]);
    if (!labelPatterns.some((pattern) => key.includes(pattern))) continue;
    const candidates = [
      normalizedLines[index - 2],
      normalizedLines[index - 1],
      normalizedLines[index + 1],
      normalizedLines[index + 2]
    ];
    const value = candidates.find((item) => /^\d{1,3}%$/.test(String(item || "")));
    if (value) return numberValue(value);
  }
  return 50;
}

function parseVisualStatisticsLines(lines = []) {
  const totalShots = numberNearLabel(lines, ["finalizacoes", "total shots"]);
  const shotsOnTarget = numberNearLabel(lines, ["finalizacoes no alvo", "shots on target"]);
  const shotsOffTarget = numberNearLabel(lines, ["finalizacoes para fora", "shots off target"]);
  const blockedShots = numberNearLabel(lines, ["finalizacoes bloqueadas", "blocked shots"]);
  const corners = numberNearLabel(lines, ["escanteios", "corner"]);
  const dangerousAttacks = numberNearLabel(lines, ["ataques perigosos", "dangerous attacks"]);
  const yellowCards = numberNearLabel(lines, ["cartoes amarelos", "yellow cards"]);
  const redCards = numberNearLabel(lines, ["cartoes vermelhos", "red cards"]);
  const bigChances = numberNearLabel(lines, ["grandes chances", "big chances"]);
  const expectedGoals = decimalPairNearLabel(lines, ["gols esperados", "expected goals", "xg"]);
  const possessionHome = sidePercentNearLabel(lines, ["posse de bola", "ball possession"]);
  const possessionAway = possessionHome ? 100 - possessionHome : 50;
  const hasRealStats = totalShots || shotsOnTarget || shotsOffTarget || blockedShots || corners || dangerousAttacks || yellowCards || redCards || bigChances || expectedGoals.total;
  if (!hasRealStats) return emptyStats({ sourceDetail: "visual_statistics_empty" });
  const calculatedTotalShots = totalShots || shotsOnTarget + shotsOffTarget + blockedShots;
  return {
    totalShots: calculatedTotalShots,
    homeTotalShots: 0,
    awayTotalShots: 0,
    shotsOnTarget,
    homeShotsOnTarget: 0,
    awayShotsOnTarget: 0,
    shotsOffTarget,
    blockedShots,
    corners,
    homeCorners: 0,
    awayCorners: 0,
    dangerousAttacks: dangerousAttacks || Math.round(calculatedTotalShots * 2.2 + corners * 2),
    attacks: 0,
    possessionHome,
    possessionAway,
    yellowCards,
    redCards,
    goalkeeperSaves: 0,
    fouls: 0,
    offsides: 0,
    bigChances,
    expectedGoals: expectedGoals.total,
    expectedGoalsHome: expectedGoals.home,
    expectedGoalsAway: expectedGoals.away,
    statsItemsMapped: [
      totalShots,
      shotsOnTarget,
      shotsOffTarget,
      blockedShots,
      corners,
      dangerousAttacks,
      yellowCards,
      redCards,
      bigChances,
      expectedGoals.total
    ].filter(Boolean).length,
    estimated: false,
    unavailable: false,
    source: "sofascore_visual_statistics",
    sourceDetail: expectedGoals.total && !totalShots ? "visual_statistics_tab:xg" : "visual_statistics_tab"
  };
}

function inferOddsFromText(text = "") {
  const odds = String(text)
    .match(/\b\d{1,2}[.,]\d{2}\b/g)
    ?.map((item) => Number(item.replace(",", ".")))
    .filter((item) => Number.isFinite(item) && item >= 1) || [];
  return {
    home: odds[0] || null,
    draw: odds[1] || null,
    away: odds[2] || null,
    raw: odds.slice(0, 6)
  };
}

function compactGameKey(homeTeam, awayTeam, eventId) {
  return String(eventId || `${homeTeam}-${awayTeam}`)
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");
}

function gameKey(game = {}, fallback = "") {
  return game.eventId || compactGameKey(game.homeTeam, game.awayTeam, game.time || game.status || fallback);
}

function statisticsUrlForGame(game = {}) {
  const raw = String(game.href || "").trim();
  if (!raw && !game.eventId) return null;
  try {
    const url = new URL(raw || DEFAULT_SOFASCORE_URL);
    if (!/(^|\.)sofascore\.com$/i.test(url.hostname)) return null;
    const eventId = String(game.eventId || "").trim();
    const cleanHash = String(url.hash || "").replace(/^#/, "");
    if (cleanHash.includes("tab:statistics")) return url.toString();
    if (cleanHash.includes("id:")) {
      url.hash = `#${cleanHash.replace(/,?tab:[^,]+/g, "")},tab:statistics`;
    } else if (eventId) {
      url.hash = `#id:${eventId},tab:statistics`;
    } else {
      url.hash = "#tab:statistics";
    }
    return url.toString();
  } catch {
    return null;
  }
}

function enrichGames(games = [], sideCards = []) {
  const sideOdds = sideCards.map((card) => ({
    text: card.text,
    odds: inferOddsFromText(card.text)
  }));
  return games
    .map((game, index) => {
      const status = normalizeCapturedStatus(game.status || "-", game.statusSource || game.source);
      const statusLabel = gameStatusLabel(status);
      const minute = minuteFromStatus(status);
      const homeScore = onlyNumber(game.homeScore ?? String(game.score || "").split("x")[0]);
      const awayScore = onlyNumber(game.awayScore ?? String(game.score || "").split("x")[1]);
      const odds = inferOddsFromText(game.rawText || "");
      const relatedSideOdds = sideOdds.find((item) => {
        const text = item.text.toLowerCase();
        return text.includes(String(game.homeTeam || "").toLowerCase()) && text.includes(String(game.awayTeam || "").toLowerCase());
      })?.odds;
      return {
        id: compactGameKey(game.homeTeam, game.awayTeam, game.eventId || index + 1),
        eventId: game.eventId || null,
        competition: game.competition || game.league || "SofaScore",
        group: game.group || null,
        time: game.time || null,
        status,
        statusLabel,
        minute,
        homeTeam: game.homeTeam,
        awayTeam: game.awayTeam,
        homeScore,
        awayScore,
        score: homeScore !== null && awayScore !== null ? `${homeScore} x ${awayScore}` : null,
        odds1x2: relatedSideOdds || odds,
        liveOdd: relatedSideOdds?.draw || odds.draw || null,
        href: game.href || null,
        rawText: game.rawText || null,
        rawLines: game.rawLines || [],
        statusSource: game.statusSource || null,
        stats: game.stats || emptyStats(),
        source: "browser_sofascore"
      };
    })
    .filter((game) => game.homeTeam && game.awayTeam && !isIgnoredCompetition(game))
    .slice(0, 80);
}

function mergeProbePayloads(payloads = []) {
  const latest = payloads.filter(Boolean).at(-1) || {};
  const gamesByKey = new Map();
  const linksByKey = new Map();
  const lines = [];
  const isApiSource = (source) => String(source || "").startsWith("api_");

  payloads.filter(Boolean).forEach((payload) => {
    (payload.lines || []).forEach((line) => {
      if (lines.length < 260) lines.push(line);
    });
    (payload.links || []).forEach((link) => {
      linksByKey.set(`${link.text}|${link.href}`, link);
    });
    (payload.games || []).forEach((game) => {
      const key = gameKey(game, gamesByKey.size + 1);
      const current = gamesByKey.get(key) || {};
      if (hasLiveStatus(current) && !hasLiveStatus(game)) {
        gamesByKey.set(key, {
          ...game,
          ...current,
          rawText: current.rawText || game.rawText || null,
          rawLines: current.rawLines?.length ? current.rawLines : game.rawLines || []
        });
        return;
      }
      if (isApiSource(current.source) && !isApiSource(game.source)) {
        gamesByKey.set(key, {
          ...game,
          ...current,
          rawText: current.rawText || game.rawText || null,
          rawLines: current.rawLines?.length ? current.rawLines : game.rawLines || []
        });
        return;
      }
      gamesByKey.set(key, { ...current, ...game });
    });
  });

  return {
    title: latest.title,
    currentUrl: latest.currentUrl,
    textLength: latest.textLength || 0,
    lines,
    games: Array.from(gamesByKey.values()),
    sideCards: payloads.flatMap((payload) => payload?.sideCards || []).slice(0, 20),
    links: Array.from(linksByKey.values()).slice(0, 60)
  };
}

function friendlyBrowserError(error) {
  const message = String(error?.message || error || "Erro desconhecido");
  if (message.includes("Executable doesn't exist") || message.includes("Please run the following command")) {
    return "Chromium do Playwright nao instalado. Rode: npx playwright install chromium";
  }
  if (message.includes("Timeout")) {
    return "Tempo limite ao abrir o SofaScore. Tente novamente ou aumente SOFASCORE_BROWSER_TIMEOUT_MS.";
  }
  return message.split("\n")[0];
}

async function clickLiveFilter(page) {
  const clicked = await page.evaluate(() => {
    const candidates = Array.from(document.querySelectorAll("button,a,div,span"))
      .map((element) => {
        const rect = element.getBoundingClientRect();
        const text = String(element.innerText || element.textContent || "").replace(/\s+/g, " ").trim();
        return { element, rect, text };
      })
      .filter(({ rect, text }) =>
        rect.width >= 40 &&
        rect.width <= 220 &&
        rect.height >= 18 &&
        rect.height <= 80 &&
        /^Ao Vivo(?:\s*\(\d+\)|\s+\d+)?$/i.test(text)
      )
      .sort((a, b) => a.rect.y - b.rect.y || a.rect.x - b.rect.x);
    const target = candidates[0]?.element;
    if (!target) return false;
    target.click();
    return true;
  }).catch(() => false);
  if (clicked) {
    await page.waitForTimeout(1000);
    await page.waitForLoadState("networkidle", { timeout: 5000 }).catch(() => {});
  }
  return clicked;
}

function cleanValue(value = "") {
  return String(value).replace(/\s+/g, " ").trim();
}

function statusFromSofaScoreEvent(event) {
  const description = cleanValue(event.status?.description || event.status?.type || "");
  const statusTime = cleanValue(event.statusTime?.prefix || event.statusTime?.current || "");
  if (/half.?time|interval|intervalo|break/i.test(description)) return "HT";
  if (/finished|ended|after/i.test(description)) return "FT";
  if (/notstarted|scheduled|postponed|canceled|cancelled/i.test(description)) return "-";
  if (isMinuteStatus(statusTime, { allowPlain: true })) return `${statusTime.replace(/[^\d+]/g, "")}'`;
  const start = Number(event.time?.currentPeriodStartTimestamp || 0);
  if (start > 0) {
    const minute = Math.floor((Date.now() / 1000 - start) / 60);
    if (minute > 0 && minute <= 130) return `${minute}'`;
  }
  if (/inprogress|live|ao vivo|1st|2nd|first half|second half|1h|2h/i.test(description)) return "Ao vivo";
  return description || "-";
}

function timeFromSofaScoreEvent(event) {
  const start = Number(event.startTimestamp || 0);
  if (!start) return null;
  return new Date(start * 1000).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
}

function mapSofaScoreEventsToGames(events = [], source = "api_in_browser") {
  return events
    .filter(isLiveSofaScoreEvent)
    .map((event) => {
      const homeTeam = cleanValue(event.homeTeam?.name || event.homeTeam?.shortName || "Mandante");
      const awayTeam = cleanValue(event.awayTeam?.name || event.awayTeam?.shortName || "Visitante");
      const homeScore = event.homeScore?.current ?? event.homeScore?.display ?? null;
      const awayScore = event.awayScore?.current ?? event.awayScore?.display ?? null;
      const competition = cleanValue(
        event.tournament?.name ||
        event.tournament?.uniqueTournament?.name ||
        event.tournament?.category?.name ||
        "SofaScore"
      );
      const group = cleanValue(event.tournament?.category?.name || event.tournament?.category?.country?.name || "");
      const status = statusFromSofaScoreEvent(event);
      return {
        eventId: event.id ? String(event.id) : null,
        href: event.slug ? `https://www.sofascore.com/pt/football/match/${event.slug}${event.id ? `#id:${event.id}` : ""}` : null,
        rawText: cleanValue(`${competition} | ${group} | ${homeTeam} x ${awayTeam} | ${status}`),
        rawLines: [competition, group, timeFromSofaScoreEvent(event), status, homeTeam, awayTeam, homeScore, awayScore].filter((item) => item !== null && item !== undefined && item !== ""),
        time: timeFromSofaScoreEvent(event),
        status,
        statusSource: source,
        competition,
        group: group || null,
        homeTeam,
        awayTeam,
        homeScore,
        awayScore,
        odds: [],
        source
      };
    })
    .filter((game) => game.homeTeam && game.awayTeam && !isIgnoredCompetition(game));
}

function collectEventsFromJson(value, output = [], seen = new Set()) {
  if (!value || typeof value !== "object" || seen.has(value)) return output;
  seen.add(value);
  if (Array.isArray(value)) {
    if (value.some((item) => item?.homeTeam && item?.awayTeam)) {
      value.forEach((item) => {
        if (item?.homeTeam && item?.awayTeam) output.push(item);
      });
      return output;
    }
    value.slice(0, 80).forEach((item) => collectEventsFromJson(item, output, seen));
    return output;
  }
  Object.values(value).slice(0, 80).forEach((item) => collectEventsFromJson(item, output, seen));
  return output;
}

async function fetchLiveEventsFromPage(page) {
  return page.evaluate(async () => {
    const response = await fetch("/api/v1/sport/football/events/live", {
      headers: {
        "accept": "application/json,text/plain,*/*"
      }
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const payload = await response.json();
    const events = Array.isArray(payload.events) ? payload.events : [];

    function clean(value = "") {
      return String(value).replace(/\s+/g, " ").trim();
    }

    function isMinute(value = "") {
      return /^\d{1,3}(\+\d{0,2})?'?$/.test(clean(value));
    }

    function statusFromEvent(event) {
      const description = clean(event.status?.description || event.status?.type || "");
      const statusTime = clean(event.statusTime?.prefix || event.statusTime?.current || "");
      if (/half.?time|interval|intervalo|break/i.test(description)) return "HT";
      if (/finished|ended|after/i.test(description)) return "FT";
      if (/notstarted|scheduled|postponed|canceled|cancelled/i.test(description)) return "-";
      if (isMinute(statusTime)) return `${statusTime.replace(/[^\d+]/g, "")}'`;
      const start = Number(event.time?.currentPeriodStartTimestamp || 0);
      if (start > 0) {
        const minute = Math.floor((Date.now() / 1000 - start) / 60);
        if (minute > 0 && minute <= 130) return `${minute}'`;
      }
      if (/inprogress|live|ao vivo|1st|2nd|first half|second half|1h|2h/i.test(description)) return "Ao vivo";
      return description || "-";
    }

    function isLiveEvent(event) {
      const description = clean(event.status?.description || event.status?.type || "");
      const statusTime = clean(event.statusTime?.prefix || event.statusTime?.current || "");
      if (/finished|ended|after|notstarted|scheduled|postponed|canceled|cancelled/i.test(description)) return false;
      if (/half.?time|interval|intervalo|break/i.test(description)) return true;
      if (isMinute(statusTime)) return true;
      const periodStart = Number(event.time?.currentPeriodStartTimestamp || 0);
      if (periodStart > 0) {
        const elapsedMinutes = Math.floor((Date.now() / 1000 - periodStart) / 60);
        if (elapsedMinutes > 0 && elapsedMinutes <= 130) return true;
      }
      if (/inprogress|live|ao vivo|1st|2nd|first half|second half|1h|2h/i.test(description)) return true;
      return false;
    }

    function timeFromEvent(event) {
      const start = Number(event.startTimestamp || 0);
      if (!start) return null;
      return new Date(start * 1000).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
    }

    const games = events.filter(isLiveEvent).map((event) => {
      const homeTeam = clean(event.homeTeam?.name || event.homeTeam?.shortName || "Mandante");
      const awayTeam = clean(event.awayTeam?.name || event.awayTeam?.shortName || "Visitante");
      const homeScore = event.homeScore?.current ?? event.homeScore?.display ?? null;
      const awayScore = event.awayScore?.current ?? event.awayScore?.display ?? null;
      const competition = clean(
        event.tournament?.name ||
        event.tournament?.uniqueTournament?.name ||
        event.tournament?.category?.name ||
        "SofaScore"
      );
      const group = clean(event.tournament?.category?.name || event.tournament?.category?.country?.name || "");
      const status = statusFromEvent(event);
      return {
        eventId: event.id ? String(event.id) : null,
        href: event.slug ? `https://www.sofascore.com/pt/football/match/${event.slug}${event.id ? `#id:${event.id}` : ""}` : null,
        rawText: clean(`${competition} | ${group} | ${homeTeam} x ${awayTeam} | ${status}`),
        rawLines: [competition, group, timeFromEvent(event), status, homeTeam, awayTeam, homeScore, awayScore].filter((item) => item !== null && item !== undefined && item !== ""),
        time: timeFromEvent(event),
        status,
        statusSource: "api_in_browser",
        competition,
        group: group || null,
        homeTeam,
        awayTeam,
        homeScore,
        awayScore,
        odds: [],
        source: "api_in_browser"
      };
    }).filter((game) => game.homeTeam && game.awayTeam);

    return {
      title: document.title,
      currentUrl: location.href,
      textLength: document.body.innerText.length,
      lines: document.body.innerText.split("\n"),
      games,
      sideCards: [],
      links: []
    };
  });
}

async function fetchGameStatisticsFromPage(page, eventId) {
  if (!eventId) return emptyStats();
  try {
    const payload = await page.evaluate(async (id) => {
      const paths = [
        `/api/v1/event/${id}/statistics`,
        `/api/v1/event/${id}/statistics?period=ALL`,
        `/api/v1/event/${id}/statistics?period=1ST`,
        `/api/v1/event/${id}/statistics?period=2ND`
      ];
      const results = [];
      for (const path of paths) {
        try {
          const response = await fetch(path, {
            credentials: "include",
            headers: {
              "accept": "application/json,text/plain,*/*"
            }
          });
          if (!response.ok) continue;
          const json = await response.json();
          if (json) results.push({ path, json });
        } catch {
          // Try next statistics endpoint variant.
        }
      }
      return results.length ? results : null;
    }, String(eventId));
    return parseSofaScoreStatistics(payload || {});
  } catch {
    return emptyStats();
  }
}

async function clickEventInCurrentList(page, game = {}) {
  const eventId = String(game.eventId || "").trim();
  const homeTeam = normalizeLine(game.homeTeam || "");
  const awayTeam = normalizeLine(game.awayTeam || "");
  if (!eventId && (!homeTeam || !awayTeam)) return false;

  for (let attempt = 0; attempt < 18; attempt += 1) {
    const clicked = await page.evaluate(({ eventId, homeTeam, awayTeam, attempt }) => {
      if (attempt === 0) window.scrollTo(0, 0);

      const clean = (value = "") => String(value).replace(/\s+/g, " ").trim();
      const links = Array.from(document.querySelectorAll('a[href], a[class*="event-hl-"]'));
      const target = links.find((link) => {
        const href = String(link.href || "");
        const className = String(link.className || "");
        const text = clean(link.innerText || link.textContent || "");
        if (eventId && (href.includes(`#id:${eventId}`) || href.includes(eventId) || className.includes(`event-hl-${eventId}`))) return true;
        return homeTeam && awayTeam && text.includes(homeTeam) && text.includes(awayTeam);
      });

      if (!target) {
        const distance = Math.max(360, Math.floor(window.innerHeight * 0.62));
        window.scrollBy(0, distance);
        return false;
      }

      target.scrollIntoView({ block: "center", inline: "nearest" });
      target.click();
      return true;
    }, { eventId, homeTeam, awayTeam, attempt }).catch(() => false);

    if (clicked) {
      await page.waitForTimeout(Math.max(1000, Number(process.env.SOFASCORE_BROWSER_PANEL_SETTLE_MS || 1800)));
      return true;
    }
    await page.waitForTimeout(250);
  }

  return false;
}

async function clickStatisticsTab(page) {
  const clicked = await page.evaluate(() => {
    const normalize = (value = "") =>
      String(value)
        .replace(/\s+/g, " ")
        .trim()
        .toLowerCase()
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "");
    const candidates = Array.from(document.querySelectorAll("button,a,div,span"))
      .map((element) => {
        const rect = element.getBoundingClientRect();
        return { element, rect, text: normalize(element.innerText || element.textContent || "") };
      })
      .filter(({ rect, text }) =>
        rect.width >= 40 &&
        rect.height >= 12 &&
        rect.x >= Math.floor(window.innerWidth * 0.42) &&
        /^estatisticas$/.test(text)
      )
      .sort((a, b) => b.rect.x - a.rect.x || a.rect.y - b.rect.y);

    const target = candidates[0]?.element;
    if (!target) return false;
    target.click();
    return true;
  }).catch(() => false);

  if (clicked) await page.waitForTimeout(Math.max(1200, Number(process.env.SOFASCORE_BROWSER_STATS_TAB_SETTLE_MS || 1800)));
  return clicked;
}

async function collectStatisticsPanelLines(page) {
  return page.evaluate(() => {
    const clean = (value = "") => String(value || "").replace(/\s+/g, " ").trim();
    const normalize = (value = "") =>
      clean(value)
        .toLowerCase()
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "");
    const markers = [
      "visao geral da partida",
      "match overview",
      "posse de bola",
      "ball possession",
      "gols esperados",
      "expected goals",
      "finalizacoes",
      "total shots"
    ];
    const panels = Array.from(document.querySelectorAll("main,section,article,aside,div"))
      .map((element) => {
        const rect = element.getBoundingClientRect();
        const text = clean(element.innerText || element.textContent || "");
        return { element, rect, text, key: normalize(text) };
      })
      .filter(({ rect, key }) =>
        rect.width >= 260 &&
        rect.height >= 160 &&
        rect.x >= Math.floor(window.innerWidth * 0.35) &&
        markers.some((marker) => key.includes(marker))
      )
      .sort((a, b) => (a.rect.width * a.rect.height) - (b.rect.width * b.rect.height));

    const source = panels[0]?.text || document.body.innerText || "";
    return source.split("\n").map(clean).filter(Boolean).slice(0, 520);
  });
}

async function fetchGameStatisticsVisually(page, game = {}) {
  try {
    const statsUrl = statisticsUrlForGame(game);
    if (statsUrl) {
      await page.goto(statsUrl, { waitUntil: "domcontentloaded", timeout: Number(process.env.SOFASCORE_BROWSER_TIMEOUT_MS || DEFAULT_TIMEOUT_MS) });
      await page.waitForTimeout(Math.max(1600, Number(process.env.SOFASCORE_BROWSER_PANEL_SETTLE_MS || 2200)));
    } else {
      const opened = await clickEventInCurrentList(page, game);
      if (!opened) return emptyStats({ sourceDetail: "visual_event_not_found" });
    }

    const tabClicked = await clickStatisticsTab(page);
    if (!tabClicked && !/tab:statistics/i.test(page.url())) return emptyStats({ sourceDetail: "visual_statistics_tab_not_found" });

    await page.waitForFunction(() => /Vis[aã]o geral da partida|Match overview|Posse de bola|Ball possession|Gols esperados|Expected goals|Finaliza[cç][oõ]es|Total shots/i.test(document.body.innerText || ""), null, { timeout: 5000 }).catch(() => {});
    const lines = await collectStatisticsPanelLines(page);
    return parseVisualStatisticsLines(lines);
  } catch {
    return emptyStats({ sourceDetail: "visual_statistics_error" });
  }
}

async function fetchGameDetailsFromPage(page, eventId) {
  if (!eventId) return null;
  try {
    const payload = await page.evaluate(async (id) => {
      const response = await fetch(`/api/v1/event/${id}`, {
        credentials: "include",
        headers: {
          "accept": "application/json,text/plain,*/*"
        }
      });
      if (!response.ok) return null;
      return response.json();
    }, String(eventId));
    const event = payload?.event || payload;
    const [game] = event?.homeTeam && event?.awayTeam ? mapSofaScoreEventsToGames([event], "api_event_detail") : [];
    return game || null;
  } catch {
    return null;
  }
}

function liveStatusRank(status) {
  const normalized = normalizeLine(status);
  const label = gameStatusLabel(normalized);
  if (minuteFromStatus(normalized)) return 4;
  if (label === "Intervalo") return 3;
  if (label === "Ao vivo") return 2;
  if (label === "Finalizado" || label === "Agendado") return 0;
  return normalized && normalized !== "-" ? 1 : 0;
}

function chooseBestLiveStatus(game, details) {
  const gameStatus = normalizeCapturedStatus(game?.status || game?.statusLabel || "-", game?.statusSource || game?.source);
  const detailStatus = normalizeCapturedStatus(details?.status || details?.statusLabel || "-", details?.statusSource || details?.source);
  const gameRank = liveStatusRank(gameStatus);
  const detailRank = liveStatusRank(detailStatus);
  return detailRank > gameRank ? detailStatus : gameStatus;
}

async function attachRealStatistics(page, games = []) {
  const maxStats = Math.max(1, Number(process.env.SOFASCORE_BROWSER_MAX_STATS_FETCH || 40));
  const maxVisualStats = Math.max(0, Number(process.env.SOFASCORE_BROWSER_MAX_VISUAL_STATS_FETCH || 25));
  const delayMs = Math.max(0, Number(process.env.SOFASCORE_BROWSER_STATS_DELAY_MS || 250));
  const enriched = [];
  let visualStatsCount = 0;
  for (const game of games) {
    if (enriched.length >= maxStats) {
      enriched.push({ ...game, stats: game.stats || emptyStats() });
      continue;
    }
    const details = await fetchGameDetailsFromPage(page, game.eventId);
    let stats = await fetchGameStatisticsFromPage(page, game.eventId);
    if (stats.unavailable && visualStatsCount < maxVisualStats) {
      const visualStats = await fetchGameStatisticsVisually(page, { ...game, ...(details || {}) });
      if (!visualStats.unavailable) stats = visualStats;
      if (visualStats.unavailable && visualStats.sourceDetail) stats = visualStats;
      visualStatsCount += 1;
    }
    const status = chooseBestLiveStatus(game, details);
    const minute = minuteFromStatus(status) || Number(game.minute || details?.minute || 0);
    enriched.push({
      ...game,
      ...(details || {}),
      status,
      statusLabel: gameStatusLabel(status),
      minute,
      stats,
      rawText: details?.rawText || game.rawText || null,
      rawLines: details?.rawLines?.length ? details.rawLines : game.rawLines || [],
      statusSource: details?.statusSource || game.statusSource || null
    });
    if (delayMs) await page.waitForTimeout(delayMs);
  }
  return enriched;
}

async function runSofaScoreBrowserProbe(options = {}) {
  const startedAt = new Date().toISOString();
  const url = options.url || process.env.SOFASCORE_BROWSER_URL || DEFAULT_SOFASCORE_URL;
  const timeoutMs = Number(options.timeoutMs || process.env.SOFASCORE_BROWSER_TIMEOUT_MS || DEFAULT_TIMEOUT_MS);
  const settleMs = Number(options.settleMs || process.env.SOFASCORE_BROWSER_SETTLE_MS || DEFAULT_SETTLE_MS);
  const captureDelayMs = Math.max(400, Number(options.captureDelayMs || process.env.SOFASCORE_BROWSER_CAPTURE_DELAY_MS || DEFAULT_CAPTURE_DELAY_MS));
  const maxCaptureSteps = Math.max(10, Number(options.maxCaptureSteps || process.env.SOFASCORE_BROWSER_MAX_CAPTURE_STEPS || DEFAULT_MAX_CAPTURE_STEPS));
  const maxEmptyCaptureSteps = Math.max(3, Number(options.maxEmptyCaptureSteps || process.env.SOFASCORE_BROWSER_MAX_EMPTY_CAPTURE_STEPS || DEFAULT_MAX_EMPTY_CAPTURE_STEPS));
  let browser;

  try {
    const { chromium } = await import("playwright");
    browser = await chromium.launch({
      headless: process.env.SOFASCORE_BROWSER_HEADLESS !== "false",
      args: ["--disable-dev-shm-usage", "--no-sandbox"]
    });
    const context = await browser.newContext({
      locale: "pt-BR",
      timezoneId: "America/Sao_Paulo",
      viewport: { width: 1365, height: 768 },
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36"
    });
    const page = await context.newPage();
    const apiNetworkGames = [];
    page.on("response", async (networkResponse) => {
      try {
        const responseUrl = networkResponse.url();
        if (!/\/api\/v1\//i.test(responseUrl) || !/\/events\/live(?:\?|$)/i.test(responseUrl)) return;
        const contentType = networkResponse.headers()["content-type"] || "";
        if (!/json/i.test(contentType)) return;
        const json = await networkResponse.json();
        const events = collectEventsFromJson(json);
        if (!events.length) return;
        apiNetworkGames.push(...mapSofaScoreEventsToGames(events, "api_network_live"));
      } catch {
        // Some SofaScore responses are not JSON or are consumed before inspection.
      }
    });
    const response = await page.goto(url, { waitUntil: "domcontentloaded", timeout: timeoutMs });
    await page.waitForTimeout(Math.max(1000, settleMs));
    await page.locator("text=Futebol").first().click({ timeout: 3000 }).catch(() => {});
    await page.waitForTimeout(500);
    await clickLiveFilter(page);
    await page.waitForLoadState("networkidle", { timeout: 7000 }).catch(() => {});
    await page.waitForTimeout(1200);
    await page.evaluate(() => window.scrollTo(0, 0)).catch(() => {});
    const apiPayload = await fetchLiveEventsFromPage(page).catch(() => null);

    const collectPayload = () => page.evaluate(() => {
      const clean = (value = "") => String(value).replace(/\s+/g, " ").trim();
      const lines = document.body.innerText.split("\n");
      const eventLinks = Array.from(document.querySelectorAll('a[class*="event-hl-"]'));
      const isTimeOrStatus = (line) => /^(\d{1,2}:\d{2}|HT|FT|INT|-|\d{1,3}(?:\+\d{0,2})?'|Ao vivo|Intervalo)$/i.test(line);
      const isScore = (line) => /^\d{1,2}$/.test(line);
      const isTeamLine = (line) =>
        /^[\p{L}\d .,'&()-]{2,}$/u.test(line) &&
        !isTimeOrStatus(line) &&
        !isScore(line) &&
        !/^(Todos|Ao Vivo|Finalizado|Proximos|Pr[oó]ximos|Probabilidades|Futebol|Sofascore|Entrar|Baixe o aplicativo|Propaganda)$/i.test(line);
      const isCompetitionLine = (line) =>
        isTeamLine(line) &&
        /(Liga|League|Cup|Copa|Serie|S[eé]rie|Premier|Division|Divis[aã]o|Campeonato|Games|Feminino|Sub-|U\d{2}|Damallsvenskan|Pervaya|Botola|Mocambola|Erovnuli)/i.test(line);

      function textLines(element) {
        return String(element?.innerText || "")
          .split("\n")
          .map(clean)
          .filter(Boolean);
      }

      function sectionInfo(link, homeTeam, awayTeam) {
        let node = link.parentElement;
        for (let depth = 0; node && depth < 8; depth += 1, node = node.parentElement) {
          const sectionLines = textLines(node).filter((line) => line.length <= 90);
          const homeIndex = sectionLines.findIndex((line) => line === homeTeam);
          const awayIndex = sectionLines.findIndex((line) => line === awayTeam);
          const eventIndex = Math.min(homeIndex >= 0 ? homeIndex : 999, awayIndex >= 0 ? awayIndex : 999);
          if (eventIndex === 999) continue;
          const before = sectionLines.slice(0, eventIndex);
          const competition = before.map((line, index) => ({ line, index })).filter((item) => isCompetitionLine(item.line)).at(-1);
          if (competition) {
            const country = before
              .slice(competition.index + 1)
              .find((line) => isTeamLine(line) && !isCompetitionLine(line) && !/Propaganda/i.test(line));
            return { competition: competition.line, group: country || null };
          }
        }
        return { competition: null, group: null };
      }

      function extractEvent(link) {
        const rect = link.getBoundingClientRect();
        const eventId = String(link.href.match(/#id:(\d+)/)?.[1] || link.className.match(/event-hl-(\d+)/)?.[1] || "");
        const divs = Array.from(link.querySelectorAll("div"));
        const timeStatusLines = textLines(divs.find((item) => String(item.className).includes("w_7xl")));
        const teamBox = divs
          .map((item) => ({ item, lines: textLines(item) }))
          .find(({ item, lines }) =>
            String(item.className).includes("ov_hidden") &&
            String(item.className).includes("min-w_") &&
            lines.length >= 2 &&
            lines.every((line) => !/^\d+$/.test(line) && !/^(\d{1,2}:\d{2}|FT|HT|INT|-|\d{1,3}(?:\+\d{0,2})?'|Ao vivo|Intervalo)$/i.test(line))
          );
        const scoreBox = divs.find((item) => String(item.className).includes("w_[38px]"));
        const scoreLines = textLines(scoreBox).filter((line) => /^\d{1,2}$/.test(line));
        const rowLines = textLines(link);
        const teamLines = teamBox?.lines?.length >= 2 ? teamBox.lines : rowLines.filter(isTeamLine).slice(-2);
        const homeTeam = teamLines[0] || rowLines[2] || "Mandante";
        const awayTeam = teamLines[1] || rowLines[3] || "Visitante";
        const statusFromTimeColumn = timeStatusLines.find((line) => /^(HT|FT|INT|-|\d{1,3}(?:\+\d{0,2})?|\d{1,3}(?:\+\d{0,2})?'|Ao vivo|Intervalo)$/i.test(line));
        const statusFromRow = rowLines.find((line) => /^(HT|FT|INT|-|\d{1,3}(?:\+\d{0,2})?'|Ao vivo|Intervalo)$/i.test(line));
        const statusLine = statusFromTimeColumn || statusFromRow;
        const timeLine = timeStatusLines.find((line) => /^\d{1,2}:\d{2}$/.test(line)) ||
          rowLines.find((line) => /^\d{1,2}:\d{2}$/.test(line));
        const section = sectionInfo(link, homeTeam, awayTeam);
        return {
          eventId,
          href: link.href,
          rawText: rowLines.join(" | "),
          rawLines: rowLines,
          time: timeLine || null,
          status: statusLine || null,
          statusSource: statusFromTimeColumn ? "time_column" : statusFromRow ? "row" : null,
          competition: section.competition,
          group: section.group,
          homeTeam,
          awayTeam,
          homeScore: scoreLines[0] || null,
          awayScore: scoreLines[1] || null,
          odds: [],
          y: Math.round(rect.y)
        };
      }

      const games = eventLinks.map(extractEvent).filter((game) => game.homeTeam && game.awayTeam);
      const sideCards = Array.from(document.querySelectorAll("div"))
        .map((element) => {
          const rect = element.getBoundingClientRect();
          return { text: clean(element.innerText || ""), x: rect.x, y: rect.y, w: rect.width, h: rect.height };
        })
        .filter((item) => item.x > 500 && item.w > 300 && /Resultado final/i.test(item.text) && /\b\d{1,2}[.,]\d{2}\b/.test(item.text))
        .slice(0, 8);
      const links = Array.from(document.querySelectorAll("a[href]"))
        .map((link) => ({ text: link.textContent.trim(), href: link.href }))
        .filter((link) => link.text && link.href.includes("sofascore.com"))
        .slice(0, 40);
      return {
        title: document.title,
        currentUrl: location.href,
        textLength: document.body.innerText.length,
        lines,
        games,
        sideCards,
        links
      };
    });

    const payloads = [];
    const visualSeenKeys = new Set();
    let emptySteps = 0;
    for (let step = 0; step < maxCaptureSteps; step += 1) {
      const payload = await collectPayload();
      const newGames = (payload.games || []).filter((game, index) => {
        const key = gameKey(game, `${step}-${index}`);
        if (!key || visualSeenKeys.has(key)) return false;
        visualSeenKeys.add(key);
        return true;
      });
      payloads.push({ ...payload, games: newGames });

      if (newGames.length) {
        emptySteps = 0;
      } else {
        emptySteps += 1;
      }

      const moved = await page.evaluate(() => {
        const before = window.scrollY;
        const distance = Math.max(360, Math.floor(window.innerHeight * 0.58));
        window.scrollBy(0, distance);
        return {
          moved: window.scrollY !== before,
          scrollY: window.scrollY,
          nearBottom: window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 12
        };
      });
      if ((!moved.moved || moved.nearBottom) && emptySteps >= 2) break;
      if (emptySteps >= maxEmptyCaptureSteps) break;
      await page.waitForTimeout(captureDelayMs);
    }

    const networkPayload = apiNetworkGames.length
      ? {
          title: await page.title().catch(() => null),
          currentUrl: page.url(),
          textLength: 0,
          lines: [],
          games: apiNetworkGames,
          sideCards: [],
          links: []
        }
      : null;
    const payload = mergeProbePayloads([networkPayload, apiPayload, ...payloads]);
    const lines = likelyFootballLines(payload.lines);
    if ((response?.status && response.status() >= 400) || payload.textLength < 100 || lines.some((line) => /forbidden|\"code\":\s*403/i.test(line))) {
      throw new Error(`SofaScore bloqueou a leitura do navegador${response?.status ? `: HTTP ${response.status()}` : ""}.`);
    }
    const games = await attachRealStatistics(
      page,
      enrichGames(payload.games?.length ? payload.games : inferGamesFromLines(lines), payload.sideCards)
    );
    await browser.close();
    return {
      ok: true,
      provider: "browser_sofascore",
      startedAt,
      finishedAt: new Date().toISOString(),
      url,
      title: payload.title,
      currentUrl: payload.currentUrl,
      textLength: payload.textLength,
      lines,
      games,
      links: payload.links,
      error: null
    };
  } catch (error) {
    if (browser) {
      try {
        await browser.close();
      } catch {
        // Ignore cleanup failure.
      }
    }
    return {
      ok: false,
      provider: "browser_sofascore",
      startedAt,
      finishedAt: new Date().toISOString(),
      url,
      title: null,
      currentUrl: null,
      textLength: 0,
      lines: [],
      games: [],
      links: [],
      error: friendlyBrowserError(error)
    };
  }
}

module.exports = {
  runSofaScoreBrowserProbe,
  __private: {
    parseSofaScoreStatistics,
    parseVisualStatisticsLines
  }
};
