const championships = ["Serie A", "Serie B"];

const teamColors = {
  Flamengo: ["#d71920", "#111111"],
  Palmeiras: ["#006437", "#ffffff"],
  Corinthians: ["#f2f2f2", "#111111"],
  Gremio: ["#00a7e1", "#111111"],
  "Atletico Mineiro": ["#111111", "#ffffff"],
  "Sao Paulo": ["#ffffff", "#d71920"],
  Internacional: ["#d71920", "#ffffff"],
  Cruzeiro: ["#1c5fb8", "#ffffff"],
  Botafogo: ["#111111", "#ffffff"],
  Bahia: ["#0057b8", "#d71920"],
  Vasco: ["#111111", "#ffffff"],
  "Athletico-PR": ["#d71920", "#111111"],
  Ceara: ["#111111", "#ffffff"],
  Sport: ["#d71920", "#f6c13a"],
  Mirassol: ["#f6c13a", "#16803c"],
  Juventude: ["#16803c", "#ffffff"],
  Goias: ["#008c45", "#ffffff"],
  Coritiba: ["#007a3d", "#ffffff"],
  Novorizontino: ["#f6c13a", "#111111"],
  "Vila Nova": ["#d71920", "#ffffff"],
  Avai: ["#1f73d8", "#ffffff"],
  Chapecoense: ["#1b8f3a", "#ffffff"],
  CRB: ["#d71920", "#ffffff"],
  Amazonas: ["#f6c13a", "#111111"],
  "Ponte Preta": ["#111111", "#ffffff"],
  Operario: ["#111111", "#ffffff"],
  Ituano: ["#d71920", "#111111"],
  Brusque: ["#f6c13a", "#d71920"],
  "Sampaio Correa": ["#f6c13a", "#16803c"],
  Londrina: ["#7dd3fc", "#ffffff"],
  Guarani: ["#16803c", "#ffffff"],
  Tombense: ["#d71920", "#ffffff"]
};

const teams = [
  { name: "Flamengo", championship: "Serie A" },
  { name: "Palmeiras", championship: "Serie A" },
  { name: "Corinthians", championship: "Serie A" },
  { name: "Gremio", championship: "Serie A" },
  { name: "Atletico Mineiro", championship: "Serie A" },
  { name: "Sao Paulo", championship: "Serie A" },
  { name: "Internacional", championship: "Serie A" },
  { name: "Cruzeiro", championship: "Serie A" },
  { name: "Botafogo", championship: "Serie A" },
  { name: "Bahia", championship: "Serie A" },
  { name: "Vasco", championship: "Serie A" },
  { name: "Athletico-PR", championship: "Serie A" },
  { name: "Ceara", championship: "Serie A" },
  { name: "Sport", championship: "Serie A" },
  { name: "Mirassol", championship: "Serie A" },
  { name: "Juventude", championship: "Serie A" },
  { name: "Goias", championship: "Serie B" },
  { name: "Coritiba", championship: "Serie B" },
  { name: "Novorizontino", championship: "Serie B" },
  { name: "Vila Nova", championship: "Serie B" },
  { name: "Avai", championship: "Serie B" },
  { name: "Chapecoense", championship: "Serie B" },
  { name: "CRB", championship: "Serie B" },
  { name: "Amazonas", championship: "Serie B" },
  { name: "Ponte Preta", championship: "Serie B" },
  { name: "Operario", championship: "Serie B" },
  { name: "Ituano", championship: "Serie B" },
  { name: "Brusque", championship: "Serie B" },
  { name: "Sampaio Correa", championship: "Serie B" },
  { name: "Londrina", championship: "Serie B" },
  { name: "Guarani", championship: "Serie B" },
  { name: "Tombense", championship: "Serie B" }
];

function teamsForChampionship(championship) {
  return teams.filter((team) => team.championship === championship);
}

function isKnownTeam(name) {
  return teams.some((team) => team.name === name);
}

module.exports = {
  championships,
  teamColors,
  teams,
  teamsForChampionship,
  isKnownTeam
};
