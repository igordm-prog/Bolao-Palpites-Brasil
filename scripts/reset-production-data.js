const path = require("path");
require("dotenv").config({ quiet: true });

const { createStore } = require("../src/store");
const { todayIso } = require("../src/utils");

const store = createStore(path.join(__dirname, "..", "data", "db.json"));
const data = store.read();

const admins = (data.users || []).filter((user) => ["admin", "super_admin"].includes(user.role));

if (!admins.length) {
  console.error("Nenhum administrador encontrado. A limpeza foi cancelada.");
  process.exit(1);
}

admins.forEach((user) => {
  user.walletBalance = 0;
  user.failedLoginCount = 0;
  user.lockedUntil = null;
});

const cleanData = {
  ...data,
  settings: {
    ...data.settings,
    appName: "Bolao Palpites Brasil",
    domain: "bolaopalpitesbrasil.com.br",
    pixKey: !data.settings?.pixKey || data.settings.pixKey === "pix@bolaobrasilplacares.com.br" ? "pix@bolaopalpitesbrasil.com.br" : data.settings.pixKey,
    withdrawalMinimum: 20
  },
  users: admins,
  pools: [],
  matches: [],
  participations: [],
  payments: [],
  guesses: [],
  passwordResets: [],
  auditLogs: [
    {
      id: 1,
      userId: null,
      action: "system.production_reset",
      tableName: "system",
      before: null,
      after: { keptAdmins: admins.length },
      ip: null,
      userAgent: "reset-production-data",
      createdAt: todayIso()
    }
  ]
};

store.write(cleanData);
if (store.close) store.close();

console.log("Sistema limpo para producao.");
console.log(`Administradores mantidos: ${admins.length}`);
