const DEFAULT_SOFASCORE_URL = "https://www.sofascore.com/pt/";
const DEFAULT_TIMEOUT_MS = 30000;
const DEFAULT_SETTLE_MS = 5000;

function normalizeLine(value = "") {
  return String(value).replace(/\s+/g, " ").trim();
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
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: timeoutMs });
    await page.waitForTimeout(Math.max(1000, settleMs));
    const payload = await page.evaluate(() => {
      const lines = document.body.innerText.split("\n");
      const links = Array.from(document.querySelectorAll("a[href]"))
        .map((link) => ({ text: link.textContent.trim(), href: link.href }))
        .filter((link) => link.text && link.href.includes("sofascore.com"))
        .slice(0, 40);
      return {
        title: document.title,
        currentUrl: location.href,
        textLength: document.body.innerText.length,
        lines,
        links
      };
    });
    const lines = likelyFootballLines(payload.lines);
    const games = inferGamesFromLines(lines);
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
