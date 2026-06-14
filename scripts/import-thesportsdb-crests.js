const fs = require("fs");
const path = require("path");
const { teams } = require("../src/teams");

const crestDir = path.join(__dirname, "..", "public", "img", "crests");
const exts = ["svg", "png", "gif", "jpg", "jpeg", "webp"];

const queryByTeam = {
  "Ypiranga-RS": ["Ypiranga"],
  "Botafogo-PB": ["Botafogo PB", "Botafogo da Paraiba"],
  "Barra-SC": ["Barra"],
  "Confianca": ["Confianca"],
  "Ferroviaria": ["Ferroviaria"],
  "Maranhao": ["Maranhao"],
  "Anapolis": ["Anapolis"],
  "Nacional-AM": ["Nacional Manaus", "Nacional FC Manaus"],
  "Sao Raimundo-RR": ["Sao Raimundo RR"],
  "Independencia-AC": ["Independencia"],
  "Araguaina-TO": ["Araguaina"],
  "Gama-DF": ["Gama"],
  "Brasiliense-DF": ["Brasiliense"],
  "Luverdense-MT": ["Luverdense"],
  "Primavera-MT": ["Primavera"],
  "Inhumas-GO": ["Inhumas"],
  "Aparecidense-GO": ["Aparecidense"],
  "Capital-DF": ["Capital Brasilia"],
  "Ceilandia-DF": ["Ceilandia"],
  "Operario-MT": ["Oper\u00e1rio V\u00e1rzea-Grandense", "Operario Varzea Grandense"],
  "Uniao-MT": ["Uniao Rondonopolis"],
  "Tuna Luso-PA": ["Tuna Luso"],
  "Aguia de Maraba-PA": ["Aguia de Maraba"],
  "Tocantinopolis-TO": ["Tocantinopolis"],
  "Sampaio Correa-MA": ["Sampaio Correa"],
  "Ferroviario-CE": ["Ferroviario"],
  "Atletico-CE": ["Atletico Cearense"],
  "Fluminense-PI": ["Fluminense PI"],
  "ABC-RN": ["ABC"],
  "America-RN": ["America de Natal"],
  "Retro-PE": ["Retro"],
  "Treze-PB": ["Treze"],
  "ASA-AL": ["ASA"],
  "CSA-AL": ["CSA"],
  "Atletico-BA": ["Atletico Alagoinhas"],
  "Operario-MS": ["Operario Campo Grande"],
  "Porto-BA": ["Porto BA"],
  "Rio Branco-ES": ["Rio Branco Atletico Clube"],
  "Vitoria-ES": ["Vitoria Futebol Clube ES"],
  "Tombense-MG": ["Tombense"],
  "Democrata GV-MG": ["Democrata GV"],
  "America-RJ": ["America RJ football"],
  "Portuguesa-RJ": ["Portuguesa RJ"],
  "Portuguesa-SP": ["Portuguesa"],
  "Agua Santa-SP": ["Agua Santa"],
  "Sampaio Correa-RJ": ["Sampaio Correa Futebol e Esporte"],
  "Marica-RJ": ["Marica"],
  "XV de Piracicaba-SP": ["XV de Piracicaba"],
  "FC Cascavel-PR": ["FC Cascavel"],
  "Guarany de Bage-RS": ["Guarany Bage"],
  "Sao Luiz-RS": ["Sao Luiz"],
  "Marcilio Dias-SC": ["Marcilio Dias"],
  "Sao Joseense-PR": ["Sao Joseense"],
  "Sao Jose-RS": ["Sao Jose"],
  "Brasil-RS": ["Brasil Pelotas"]
};

const manualPending = new Set([]);

const manualSources = {
  "Nacional-AM": "https://upload.wikimedia.org/wikipedia/pt/a/af/Nacional_FC_Amazonas_2021.png",
  "Capital-DF": "https://upload.wikimedia.org/wikipedia/pt/a/a8/Capital_CF_escudo_%282024%29.png",
  "Central-PE": "https://upload.wikimedia.org/wikipedia/pt/2/2a/CentralSC.png",
  "Porto-BA": "https://upload.wikimedia.org/wikipedia/pt/c/cc/Porto_SC_%28Bahia%29_escudo.png",
  "Portuguesa-RJ": "https://commons.wikimedia.org/wiki/Special:FilePath/Associa%C3%A7%C3%A3o_Atl%C3%A9tica_Portuguesa-RJ.png",
  "Democrata GV-MG": "https://upload.wikimedia.org/wikipedia/commons/4/44/Democrata_Futebol_Clube.svg",
  "America-RJ": "https://commons.wikimedia.org/wiki/Special:FilePath/America%20Football%20Club%20%28Rio%20de%20Janeiro%2C%20Brazil%29%20logo.svg"
};

function slug(name = "") {
  return String(name)
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");
}

function baseName(name) {
  return name.replace(/-(AC|AL|AM|AP|BA|CE|DF|ES|GO|MA|MG|MS|MT|PA|PB|PE|PI|PR|RJ|RN|RO|RR|RS|SC|SE|SP|TO)$/, "");
}

function existingCrest(name) {
  const fileSlug = slug(name);
  return exts.find((ext) => fs.existsSync(path.join(crestDir, `${fileSlug}.${ext}`)));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchJsonWithRetry(url) {
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    const response = await fetch(url);
    if (response.status !== 429) return response.json();
    const wait = attempt * 8000;
    console.log(`Limite da API, aguardando ${wait / 1000}s...`);
    await sleep(wait);
  }
  return null;
}

async function findTeam(name) {
  if (manualPending.has(name)) return null;
  const queries = queryByTeam[name] || [baseName(name)];
  for (const query of queries) {
    const url = `https://www.thesportsdb.com/api/v1/json/3/searchteams.php?t=${encodeURIComponent(query)}`;
    const data = await fetchJsonWithRetry(url);
    const team = data?.teams?.[0];
    await sleep(1700);
    if (!team?.strBadge || team.strSport !== "Soccer") continue;
    const text = `${team.strTeam} ${team.strTeamAlternate || ""} ${team.strLeague || ""} ${team.strLeague2 || ""} ${team.strLocation || ""}`;
    if (!/Brazil|Brazilian|Brasil|Acre|Alagoas|Amazonas|Amapa|Bahia|Ceara|Distrito|Espirito|Goias|Maranhao|Mato|Minas|Para|Paraiba|Parana|Pernambuco|Piaui|Roraima|Rondonia|Sergipe|Tocantins|Janeiro|Paulo|Sul|Catarina/i.test(text)) continue;
    return team;
  }
  return null;
}

function extensionFrom(url, contentType) {
  const fromUrl = new URL(url).pathname.split(".").pop()?.toLowerCase();
  if (exts.includes(fromUrl)) return fromUrl;
  if (contentType.includes("svg")) return "svg";
  if (contentType.includes("png")) return "png";
  if (contentType.includes("jpeg")) return "jpg";
  if (contentType.includes("gif")) return "gif";
  if (contentType.includes("webp")) return "webp";
  return "png";
}

async function downloadBadge(name, badgeUrl) {
  let response = null;
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    response = await fetch(badgeUrl);
    if (response.ok) break;
    if (response.status !== 429) throw new Error(`HTTP ${response.status}`);
    const wait = attempt * 8000;
    console.log(`Limite no download, aguardando ${wait / 1000}s...`);
    await sleep(wait);
  }
  if (!response?.ok) throw new Error(`HTTP ${response?.status}`);
  const buffer = Buffer.from(await response.arrayBuffer());
  const ext = extensionFrom(badgeUrl, response.headers.get("content-type") || "");
  const filePath = path.join(crestDir, `${slug(name)}.${ext}`);
  fs.writeFileSync(filePath, buffer);
  return filePath;
}

async function main() {
  fs.mkdirSync(crestDir, { recursive: true });
  const uniqueTeams = [...new Map(teams.map((team) => [team.name, team])).values()];
  const missing = uniqueTeams.filter((team) => !existingCrest(team.name));
  const notFound = [];

  for (const team of missing) {
    if (manualSources[team.name]) {
      const filePath = await downloadBadge(team.name, manualSources[team.name]);
      console.log(`OK: ${team.name} <- Wikimedia (${path.basename(filePath)})`);
      await sleep(600);
      continue;
    }
    const source = await findTeam(team.name);
    if (!source) {
      notFound.push(team.name);
      console.log(`Pendente: ${team.name}`);
      continue;
    }
    const filePath = await downloadBadge(team.name, source.strBadge);
    console.log(`OK: ${team.name} <- ${source.strTeam} (${path.basename(filePath)})`);
  }

  console.log("");
  console.log(`Importacao concluida. Pendentes: ${notFound.length}`);
  if (notFound.length) console.log(notFound.join("\n"));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
