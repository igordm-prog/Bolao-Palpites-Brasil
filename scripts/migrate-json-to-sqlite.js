require("dotenv").config({ quiet: true });

const fs = require("fs");
const path = require("path");
const { createSqliteStore, sqlitePathFromUrl } = require("../src/store");

const rootDir = path.join(__dirname, "..");
const jsonPath = process.argv[2] ? path.resolve(process.argv[2]) : path.join(rootDir, "data", "db.json");
const databaseUrl = process.env.DATABASE_URL || "sqlite:data/bolao.sqlite";

if (!databaseUrl.startsWith("sqlite:")) {
  console.error("DATABASE_URL precisa começar com sqlite: para esta migracao.");
  process.exit(1);
}

if (!fs.existsSync(jsonPath)) {
  console.error(`Arquivo JSON nao encontrado: ${jsonPath}`);
  process.exit(1);
}

const sqlitePath = sqlitePathFromUrl(databaseUrl, rootDir);
const backupPath = fs.existsSync(sqlitePath) ? `${sqlitePath}.backup-${Date.now()}` : null;

if (backupPath) {
  fs.copyFileSync(sqlitePath, backupPath);
  console.log(`Backup do SQLite existente criado em: ${backupPath}`);
}

const data = JSON.parse(fs.readFileSync(jsonPath, "utf8"));
const store = createSqliteStore(sqlitePath);
store.write(data);
store.close();

console.log(`Migracao concluida: ${jsonPath} -> ${sqlitePath}`);
console.log(`Usuarios: ${data.users?.length || 0}`);
console.log(`Boloes: ${data.pools?.length || 0}`);
console.log(`Pagamentos: ${data.payments?.length || 0}`);
