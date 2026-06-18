require("dotenv").config({ quiet: true });

const { runSofaScoreBrowserProbe } = require("../src/services/sofascoreBrowser");

(async () => {
  const result = await runSofaScoreBrowserProbe({
    url: process.argv[2] || process.env.SOFASCORE_BROWSER_URL || "https://www.sofascore.com/pt/futebol/"
  });
  console.log(JSON.stringify({
    ok: result.ok,
    url: result.currentUrl || result.url,
    title: result.title,
    textLength: result.textLength,
    games: result.games,
    firstLines: result.lines.slice(0, 30),
    error: result.error
  }, null, 2));
  if (!result.ok) process.exitCode = 1;
})();
