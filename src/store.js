const fs = require("fs");
const path = require("path");

const initialData = {
  settings: {
    appName: "Bolao Brasil Placares",
    domain: "bolaobrasilplacares.com.br",
    entryAdminFeePercent: 10,
    depositMinimum: 20,
    withdrawalMinimum: 20,
    pixKey: "pix@bolaobrasilplacares.com.br"
  },
  users: [],
  pools: [],
  matches: [],
  participations: [],
  payments: [],
  guesses: [],
  passwordResets: [],
  auditLogs: []
};

const collectionNames = [
  "users",
  "pools",
  "matches",
  "participations",
  "payments",
  "guesses",
  "passwordResets",
  "auditLogs"
];

function cloneInitialData() {
  return structuredClone(initialData);
}

function createJsonStore(filePath) {
  function read() {
    if (!fs.existsSync(filePath)) {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, JSON.stringify(initialData, null, 2));
      return cloneInitialData();
    }
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  }

  function write(data) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
  }

  function update(mutator) {
    const data = read();
    const result = mutator(data);
    write(data);
    return result;
  }

  return { type: "json", read, write, update, nextId };
}

function createSqliteStore(databasePath) {
  const Database = require("better-sqlite3");
  fs.mkdirSync(path.dirname(databasePath), { recursive: true });
  const db = new Database(databasePath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");

  db.exec(`
    CREATE TABLE IF NOT EXISTS settings (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      data TEXT NOT NULL
    );
  `);

  collectionNames.forEach((name) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS ${name} (
        id INTEGER PRIMARY KEY,
        data TEXT NOT NULL
      );
    `);
  });

  const readCollectionStatements = Object.fromEntries(
    collectionNames.map((name) => [name, db.prepare(`SELECT data FROM ${name} ORDER BY id ASC`)])
  );
  const clearStatements = Object.fromEntries(
    collectionNames.map((name) => [name, db.prepare(`DELETE FROM ${name}`)])
  );
  const insertStatements = Object.fromEntries(
    collectionNames.map((name) => [name, db.prepare(`INSERT INTO ${name} (id, data) VALUES (?, ?)`)])
  );
  const readSettings = db.prepare("SELECT data FROM settings WHERE id = 1");
  const writeSettings = db.prepare(`
    INSERT INTO settings (id, data) VALUES (1, ?)
    ON CONFLICT(id) DO UPDATE SET data = excluded.data
  `);

  const writeTransaction = db.transaction((data) => {
    writeSettings.run(JSON.stringify(data.settings || initialData.settings));
    collectionNames.forEach((name) => {
      clearStatements[name].run();
      (data[name] || []).forEach((item) => {
        insertStatements[name].run(Number(item.id || 0), JSON.stringify(item));
      });
    });
  });

  function read() {
    const settingsRow = readSettings.get();
    if (!settingsRow) {
      writeSettings.run(JSON.stringify(initialData.settings));
    }

    const data = {
      settings: settingsRow ? JSON.parse(settingsRow.data) : structuredClone(initialData.settings)
    };

    collectionNames.forEach((name) => {
      data[name] = readCollectionStatements[name].all().map((row) => JSON.parse(row.data));
    });

    return data;
  }

  function write(data) {
    writeTransaction(data);
  }

  function update(mutator) {
    const data = read();
    const result = mutator(data);
    write(data);
    return result;
  }

  return {
    type: "sqlite",
    databasePath,
    read,
    write,
    update,
    nextId,
    close: () => db.close()
  };
}

function sqlitePathFromUrl(databaseUrl, fallbackDir) {
  const rawPath = databaseUrl.replace(/^sqlite:/, "");
  if (!rawPath || rawPath === ":memory:") return rawPath || ":memory:";
  return path.isAbsolute(rawPath) ? rawPath : path.join(fallbackDir, rawPath);
}

function createStore(defaultJsonPath, options = {}) {
  const databaseUrl = options.databaseUrl || process.env.DATABASE_URL;
  const rootDir = options.rootDir || path.dirname(path.dirname(defaultJsonPath));

  if (databaseUrl?.startsWith("sqlite:")) {
    return createSqliteStore(sqlitePathFromUrl(databaseUrl, rootDir));
  }

  return createJsonStore(defaultJsonPath);
}

function nextId(data, key) {
  const rows = data[key] || [];
  const max = rows.reduce((highest, item) => Math.max(highest, item.id || 0), 0);
  return max + 1;
}

module.exports = {
  initialData,
  createStore,
  createJsonStore,
  createSqliteStore,
  sqlitePathFromUrl
};
