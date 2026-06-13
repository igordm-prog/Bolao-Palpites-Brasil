const { todayIso } = require("../utils");

function audit(data, actorId, action, tableName, before = null, after = null, req = null) {
  data.auditLogs.push({
    id: data.auditLogs.reduce((max, item) => Math.max(max, item.id || 0), 0) + 1,
    actorId,
    action,
    tableName,
    before,
    after,
    ip: req?.ip || null,
    userAgent: req?.headers?.["user-agent"] || null,
    createdAt: todayIso()
  });
}

module.exports = { audit };
