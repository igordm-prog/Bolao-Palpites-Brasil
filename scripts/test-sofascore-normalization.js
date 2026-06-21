const assert = require("assert");

const { dashboardFromSofaScoreSnapshot } = require("../src/services/liveEntries");
const { __private: sofaScorePrivate } = require("../src/services/sofascoreBrowser");

const nowSeconds = 2_000_000;
assert.strictEqual(sofaScorePrivate.minuteFromSofaScoreEvent({
  status: { description: "1st half" },
  time: { currentPeriodStartTimestamp: nowSeconds - 18 * 60 }
}, nowSeconds), 18);
assert.strictEqual(sofaScorePrivate.minuteFromSofaScoreEvent({
  status: { description: "2nd half" },
  time: { currentPeriodStartTimestamp: nowSeconds - 18 * 60 }
}, nowSeconds), 63);
assert.strictEqual(sofaScorePrivate.minuteFromSofaScoreEvent({
  status: { description: "2nd half" },
  statusTime: { prefix: "71" },
  time: { currentPeriodStartTimestamp: nowSeconds - 26 * 60 }
}, nowSeconds), 71);
assert.strictEqual(sofaScorePrivate.formatSofaScoreMinute(63, {
  status: { description: "2nd half" }
}), "63'");
assert.strictEqual(sofaScorePrivate.formatSofaScoreMinute(97, {
  status: { description: "2nd half" }
}), "90+7'");

const snapshot = {
  ok: true,
  finishedAt: new Date().toISOString(),
  games: [
    {
      eventId: "live-added-time",
      competition: "Liga Teste",
      status: "90+'",
      homeTeam: "Time A",
      awayTeam: "Time B",
      homeScore: 1,
      awayScore: 1,
      stats: {
        totalShots: 10,
        shotsOnTarget: 4,
        corners: 5,
        dangerousAttacks: 28,
        redCards: 0,
        estimated: false,
        unavailable: false
      }
    },
    {
      eventId: "live-plain-minute",
      competition: "Liga Teste",
      status: "53",
      homeTeam: "Time C",
      awayTeam: "Time D",
      homeScore: 0,
      awayScore: 0,
      stats: {
        totalShots: 8,
        shotsOnTarget: 3,
        corners: 3,
        dangerousAttacks: 24,
        redCards: 0,
        estimated: false,
        unavailable: false
      }
    },
    {
      eventId: "live-label",
      competition: "Liga Teste",
      status: "-",
      statusLabel: "Ao vivo",
      homeTeam: "Time E",
      awayTeam: "Time F",
      homeScore: 0,
      awayScore: 0,
      stats: { estimated: true, unavailable: true }
    },
    {
      eventId: "interval",
      competition: "Liga Teste",
      status: "HT",
      homeTeam: "Time G",
      awayTeam: "Time H",
      homeScore: 1,
      awayScore: 0,
      stats: { estimated: true, unavailable: true }
    },
    {
      eventId: "finished",
      competition: "Liga Teste",
      status: "FT",
      homeTeam: "Time I",
      awayTeam: "Time J",
      homeScore: 2,
      awayScore: 0,
      stats: { estimated: false, unavailable: false }
    }
  ]
};

const dashboard = dashboardFromSofaScoreSnapshot(snapshot);
assert.strictEqual(dashboard.matches.length, 4, "deve manter apenas jogos ao vivo/intervalo");

const addedTime = dashboard.matches.find((match) => match.id.includes("live-added-time"));
assert(addedTime, "deve aceitar minuto 90+'");
assert.strictEqual(addedTime.minute, 90);
assert.strictEqual(addedTime.status, "Ao vivo");

const plainMinute = dashboard.matches.find((match) => match.id.includes("live-plain-minute"));
assert(plainMinute, "deve aceitar minuto visual sem apostrofo");
assert.strictEqual(plainMinute.minute, 53);
assert.strictEqual(plainMinute.status, "Ao vivo");

const interval = dashboard.matches.find((match) => match.id.includes("interval"));
assert(interval, "deve aceitar intervalo");
assert.strictEqual(interval.status, "Intervalo");

assert(!dashboard.matches.some((match) => match.id.includes("finished")), "nao deve manter finalizados");

console.log("Normalizacao SofaScore OK");
