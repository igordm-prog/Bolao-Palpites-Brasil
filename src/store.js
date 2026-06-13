const fs = require("fs");
const path = require("path");

function createStore(filePath) {
  const initialData = {
    settings: {
      appName: "Bolao Brasil Placares",
      domain: "bolaobrasilplacares.com.br",
      entryAdminFeePercent: 10,
      depositMinimum: 20,
      withdrawalMinimum: 30,
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

  function read() {
    if (!fs.existsSync(filePath)) {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, JSON.stringify(initialData, null, 2));
      return structuredClone(initialData);
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

  function nextId(data, key) {
    const max = data[key].reduce((highest, item) => Math.max(highest, item.id || 0), 0);
    return max + 1;
  }

  return { read, write, update, nextId };
}

module.exports = { createStore };
