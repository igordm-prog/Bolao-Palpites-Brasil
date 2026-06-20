const assert = require("assert");

const { __private } = require("../src/services/liveEntries");

const {
  normalizarEstatisticas,
  calcularAPPM,
  calcularCG,
  avaliarGolLimite1T,
  avaliarGolLimite2T,
  avaliarCantoLimite,
  montarMensagemAlertaSemOdd,
  validarJanelaCantoLimite
} = __private;

assert.strictEqual(calcularAPPM(30, 25), 1.2);
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
    shotsOnTarget: 2,
    corners: 3,
    dangerousAttacks: 32,
    possessionHome: 62,
    possessionAway: 38,
    expectedGoals: 1.15,
    expectedGoalsHome: 1.15,
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
    shotsOnTarget: 3,
    corners: 7,
    dangerousAttacks: 92,
    possessionHome: 62,
    possessionAway: 38,
    expectedGoals: 1.05,
    expectedGoalsHome: 1.05,
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
