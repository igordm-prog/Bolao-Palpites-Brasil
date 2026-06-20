const assert = require("assert");

const { __private } = require("../src/services/sofascoreBrowser");

const { parseSofaScoreStatistics, parseVisualStatisticsLines } = __private;

const apiPayload = [
  {
    path: "/api/v1/event/123/statistics?period=ALL",
    json: {
      statistics: [
        {
          period: "ALL",
          groups: [
            {
              groupName: "Match overview",
              statisticsItems: [
                { name: "Ball possession", home: "62%", away: "38%" },
                { name: "Expected goals (xG)", home: "1.17", away: "0.42" },
                { name: "Big chances", home: "2", away: "1" },
                { name: "Total shots", home: "8", away: "4" },
                { name: "Shots on target", home: "4", away: "1" },
                { name: "Shots off target", home: "3", away: "2" },
                { name: "Blocked shots", home: "1", away: "1" },
                { name: "Corner kicks", home: "5", away: "2" },
                { name: "Yellow cards", home: "1", away: "0" }
              ]
            }
          ]
        }
      ]
    }
  },
  {
    path: "/api/v1/event/123/statistics?period=1ST",
    json: {
      statistics: [
        {
          period: "1ST",
          groups: [
            {
              statisticsItems: [
                { name: "Total shots", home: "3", away: "2" },
                { name: "Shots on target", home: "1", away: "1" },
                { name: "Corner kicks", home: "2", away: "1" }
              ]
            }
          ]
        }
      ]
    }
  }
];

const parsed = parseSofaScoreStatistics(apiPayload);
assert.strictEqual(parsed.unavailable, false);
assert.strictEqual(parsed.source, "sofascore_statistics");
assert.strictEqual(parsed.totalShots, 12, "nao deve somar ALL com 1ST");
assert.strictEqual(parsed.homeTotalShots, 8);
assert.strictEqual(parsed.awayTotalShots, 4);
assert.strictEqual(parsed.shotsOnTarget, 5);
assert.strictEqual(parsed.corners, 7);
assert.strictEqual(parsed.bigChances, 3);
assert.strictEqual(parsed.possessionHome, 62);
assert.strictEqual(parsed.possessionAway, 38);
assert.strictEqual(parsed.expectedGoals, 1.59);
assert.strictEqual(parsed.yellowCards, 1);

const visual = parseVisualStatisticsLines([
  "62%",
  "Posse de bola",
  "38%",
  "1.17",
  "Gols esperados (xG)",
  "0.42",
  "8",
  "Finalizacoes",
  "4",
  "4",
  "Finalizacoes no alvo",
  "1",
  "5",
  "Escanteios",
  "2"
]);

assert.strictEqual(visual.unavailable, false);
assert.strictEqual(visual.totalShots, 12);
assert.strictEqual(visual.shotsOnTarget, 5);
assert.strictEqual(visual.corners, 7);
assert.strictEqual(visual.possessionHome, 62);
assert.strictEqual(visual.expectedGoals, 1.59);
assert.strictEqual(visual.expectedGoalsHome, 1.17);
assert.strictEqual(visual.expectedGoalsAway, 0.42);

const visualOnlyXg = parseVisualStatisticsLines([
  "38%",
  "Posse de bola",
  "62%",
  "0.24",
  "Gols esperados (xG)",
  "0.83"
]);

assert.strictEqual(visualOnlyXg.unavailable, false);
assert.strictEqual(visualOnlyXg.sourceDetail, "visual_statistics_tab:xg");
assert.strictEqual(visualOnlyXg.expectedGoals, 1.07);

console.log("Estatisticas SofaScore OK");
