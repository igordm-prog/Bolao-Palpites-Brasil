const assert = require("assert");

const { __private } = require("../src/services/liveEntries");

const {
  normalizarEstatisticas,
  calcularPXG,
  calcularCG,
  avaliarGolLimite1T,
  avaliarGolLimite2T,
  avaliarCantoLimite,
  montarMensagemAlertaSemOdd,
  validarJanelaCantoLimite
} = __private;

assert.strictEqual(calcularPXG(60, 1).approved, true);
assert.strictEqual(calcularPXG(62, 1.31).approved, true);
assert.strictEqual(calcularPXG(59, 1.8).approved, false);
assert.strictEqual(calcularPXG(65, 0.99).approved, false);
assert.strictEqual(calcularCG(8, 3, 4), 15);
assert.strictEqual(validarJanelaCantoLimite(1, 38), true);
assert.strictEqual(validarJanelaCantoLimite(1, 35), false);
assert.strictEqual(validarJanelaCantoLimite(2, 86), true);

const firstHalf = normalizarEstatisticas({
  id: "jogo-1",
  league: "Brasileirao Serie A",
  homeTeam: "Flamengo",
  awayTeam: "Bahia",
  minute: 27,
  homeScore: 0,
  awayScore: 0,
  stats: {
    totalShots: 7,
    homeTotalShots: 7,
    awayTotalShots: 0,
    shotsOnTarget: 2,
    homeShotsOnTarget: 2,
    awayShotsOnTarget: 0,
    corners: 3,
    homeCorners: 3,
    awayCorners: 0,
    possessionHome: 62,
    possessionAway: 38,
    expectedGoals: 1.35,
    expectedGoalsHome: 1.35,
    expectedGoalsAway: 0,
    estimated: false,
    unavailable: false
  }
});

const goal1 = avaliarGolLimite1T(firstHalf);
assert.strictEqual(goal1.approved, true);
assert.strictEqual(avaliarGolLimite2T(firstHalf).approved, false);

const alert = montarMensagemAlertaSemOdd(firstHalf, goal1);
assert.strictEqual(alert.entrada, "Gol Limite 1o Tempo");
assert(alert.text.includes("Entrada: Gol Limite 1o Tempo"));
assert(alert.text.includes("PXG do mandante"));
assert(!/odd|stake|betano/i.test(alert.text));

const secondHalf = normalizarEstatisticas({
  id: "jogo-2",
  league: "Premier League",
  homeTeam: "Time Casa",
  awayTeam: "Time Fora",
  minute: 86,
  homeScore: 0,
  awayScore: 1,
  stats: {
    totalShots: 11,
    homeTotalShots: 11,
    awayTotalShots: 0,
    shotsOnTarget: 3,
    homeShotsOnTarget: 3,
    awayShotsOnTarget: 0,
    corners: 7,
    homeCorners: 7,
    awayCorners: 0,
    possessionHome: 62,
    possessionAway: 38,
    expectedGoals: 1.35,
    expectedGoalsHome: 1.35,
    expectedGoalsAway: 0.2,
    estimated: false,
    unavailable: false
  }
});

assert.strictEqual(avaliarGolLimite2T(secondHalf).approved, true);
assert.strictEqual(avaliarCantoLimite(secondHalf).approved, true);

const missingStats = normalizarEstatisticas({
  id: "jogo-3",
  league: "Liga Teste",
  homeTeam: "A",
  awayTeam: "B",
  minute: 40,
  stats: { estimated: true, unavailable: true }
});

assert.strictEqual(avaliarGolLimite1T(missingStats).approved, false);

console.log("Funis de entradas ao vivo OK");
