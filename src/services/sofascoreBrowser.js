const DEFAULT_SOFASCORE_URL = "https://www.sofascore.com/pt/";
const DEFAULT_TIMEOUT_MS = 30000;
const DEFAULT_SETTLE_MS = 5000;

function normalizeLine(value = "") {
  return String(value).replace(/\s+/g, " ").trim();
}

function onlyNumber(value) {
  const parsed = Number(String(value || "").replace(",", "."));
  return Number.isFinite(parsed) ? parsed : null;
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
    .slice(0, 180);
}

function inferGamesFromLines(lines) {
  const games = [];
  const invalidTeams = new Set(["ENTRAR", "Em Tendência", "Futebol", "Favoritos", "Competições", "Hoje"]);
  const isTime = (line) => /^(\d{1,2}:\d{2}|HT|FT|INT|\d{1,3}')$/i.test(line);
  const isStatus = (line) => /^(-|HT|FT|INT|AET|PEN|\d{1,3}')$/i.test(line);
  const isScore = (line) => /^\d{1,2}$/.test(line);
  const isTeam = (line) =>
    /^[\p{L}\d .,'()-]{2,}$/u.test(line) &&
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
  return games.slice(0, 30);
}

function gameStatusLabel(status) {
  if (!status || status === "-") return "Agendado";
  if (/^\d{1,3}'?$/.test(status)) return "Ao vivo";
  if (status === "HT" || status === "INT") return "Intervalo";
  if (status === "FT") return "Finalizado";
  return status;
}

function minuteFromStatus(status) {
  const match = String(status || "").match(/^(\d{1,3})'?$/);
  return match ? Number(match[1]) : 0;
}

function buildEstimatedStats(game) {
  const minute = Number(game.minute || 0);
  const goals = Number(game.homeScore || 0) + Number(game.awayScore || 0);
  const live = minute > 0 && game.statusLabel !== "Finalizado";
  return {
    totalShots: live ? Math.max(0, Math.round(minute / 5) + goals * 2) : 0,
    shotsOnTarget: live ? Math.max(0, Math.round(minute / 14) + goals) : 0,
    corners: live ? Math.max(0, Math.round(minute / 16)) : 0,
    dangerousAttacks: live ? Math.max(0, Math.round(minute * 0.75)) : 0,
    possessionHome: 50,
    yellowCards: 0,
    redCards: 0,
    estimated: true
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

function enrichGames(games = [], sideCards = []) {
  const sideOdds = sideCards.map((card) => ({
    text: card.text,
    odds: inferOddsFromText(card.text)
  }));
  return games
    .map((game, index) => {
      const status = normalizeLine(game.status || "-");
      const minute = minuteFromStatus(status);
      const homeScore = onlyNumber(game.homeScore ?? String(game.score || "").split("x")[0]);
      const awayScore = onlyNumber(game.awayScore ?? String(game.score || "").split("x")[1]);
      const odds = inferOddsFromText(game.rawText || "");
      const relatedSideOdds = sideOdds.find((item) => {
        const text = item.text.toLowerCase();
        return text.includes(String(game.homeTeam || "").toLowerCase()) && text.includes(String(game.awayTeam || "").toLowerCase());
      })?.odds;
      const enriched = {
        id: compactGameKey(game.homeTeam, game.awayTeam, game.eventId || index + 1),
        eventId: game.eventId || null,
        competition: game.competition || game.league || "SofaScore",
        group: game.group || null,
        time: game.time || null,
        status,
        statusLabel: gameStatusLabel(status),
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
        stats: buildEstimatedStats({
          minute,
          statusLabel: gameStatusLabel(status),
          homeScore: homeScore || 0,
          awayScore: awayScore || 0
        }),
        source: "browser_sofascore"
      };
      return enriched;
    })
    .filter((game) => game.homeTeam && game.awayTeam)
    .slice(0, 40);
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

async function runSofaScoreBrowserProbe(options = {}) {
  const startedAt = new Date().toISOString();
  const url = options.url || process.env.SOFASCORE_BROWSER_URL || DEFAULT_SOFASCORE_URL;
  const timeoutMs = Number(options.timeoutMs || process.env.SOFASCORE_BROWSER_TIMEOUT_MS || DEFAULT_TIMEOUT_MS);
  const settleMs = Number(options.settleMs || process.env.SOFASCORE_BROWSER_SETTLE_MS || DEFAULT_SETTLE_MS);
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
    const response = await page.goto(url, { waitUntil: "domcontentloaded", timeout: timeoutMs });
    await page.waitForTimeout(Math.max(1000, settleMs));
    const payload = await page.evaluate(() => {
      const clean = (value = "") => String(value).replace(/\s+/g, " ").trim();
      const lines = document.body.innerText.split("\n");
      const eventLinks = Array.from(document.querySelectorAll('a[class*="event-hl-"]'));
      const headers = Array.from(document.querySelectorAll("div, a"))
        .map((element) => {
          const rect = element.getBoundingClientRect();
          return {
            y: rect.y,
            text: clean(element.innerText || element.textContent || ""),
            className: String(element.className || "")
          };
        })
        .filter((item) => item.y > 240 && item.y < 720 && item.text.length >= 3 && item.text.length <= 70);

      function textLines(element) {
        return String(element?.innerText || "")
          .split("\n")
          .map(clean)
          .filter(Boolean);
      }

      function nearestHeader(y, pattern) {
        return headers
          .filter((item) => item.y < y && pattern.test(item.text))
          .sort((a, b) => b.y - a.y)[0]?.text || null;
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
            lines.every((line) => !/^\d+$/.test(line) && !/^(\d{1,2}:\d{2}|FT|HT|INT|-|\d{1,3}')$/.test(line))
          );
        const scoreBox = divs.find((item) => String(item.className).includes("w_[38px]"));
        const scoreLines = textLines(scoreBox).filter((line) => /^\d{1,2}$/.test(line));
        const rowLines = textLines(link);
        const homeTeam = teamBox?.lines?.[0] || rowLines[2] || "Mandante";
        const awayTeam = teamBox?.lines?.[1] || rowLines[3] || "Visitante";
        const competition = nearestHeader(rect.y, /(Copa|Liga|Serie|Série|Campeonato|Premier|World|Cup|Bundesliga|Libertadores|Sul-Americana|FIFA)/i);
        const group = nearestHeader(rect.y, /^(Grupo|Rodada|Round|Fase)/i);
        return {
          eventId,
          href: link.href,
          rawText: rowLines.join(" | "),
          rawLines: rowLines,
          time: timeStatusLines[0] || rowLines[0] || null,
          status: timeStatusLines[1] || rowLines[1] || null,
          competition,
          group,
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
    const lines = likelyFootballLines(payload.lines);
    if ((response?.status && response.status() >= 400) || payload.textLength < 100 || lines.some((line) => /forbidden|\"code\":\s*403/i.test(line))) {
      throw new Error(`SofaScore bloqueou a leitura do navegador${response?.status ? `: HTTP ${response.status()}` : ""}.`);
    }
    const games = enrichGames(payload.games?.length ? payload.games : inferGamesFromLines(lines), payload.sideCards);
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
  runSofaScoreBrowserProbe
};
