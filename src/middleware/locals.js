const fs = require("fs");
const path = require("path");
const {
  formatMoney,
  formatDateTime,
  labelForAuditAction,
  labelForPaymentMethod,
  labelForPaymentType,
  labelForRole,
  labelForStatus,
  labelForTableName,
  publicUser
} = require("../utils");

function crestSlug(name = "") {
  return String(name)
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");
}

const crestDir = path.join(__dirname, "..", "..", "public", "img", "crests");

function attachLocals(store) {
  return (req, res, next) => {
    const data = store.read();
    const user = data.users.find((item) => item.id === req.session.userId);
    const navPool =
      data.pools.find((pool) => pool.status === "open") ||
      data.pools.find((pool) => pool.status === "draft") ||
      data.pools[0] ||
      null;
    res.locals.currentUser = publicUser(user);
    res.locals.settings = {
      ...data.settings,
      appName: "Bolao Palpites Brasil",
      domain: "bolaopalpitesbrasil.com.br",
      withdrawalMinimum: 20
    };
    res.locals.navPool = navPool;
    res.locals.navGamesHref = navPool ? `/app/boloes/${navPool.id}/palpites` : user ? "/app/conta" : "/login";
    res.locals.navRankingHref = navPool ? `/app/boloes/${navPool.id}/ranking` : user ? "/app/conta" : "/login";
    res.locals.errors = req.flash("error");
    res.locals.successes = req.flash("success");
    res.locals.formatMoney = formatMoney;
    res.locals.formatDateTime = formatDateTime;
    res.locals.labelForStatus = labelForStatus;
    res.locals.labelForPaymentType = labelForPaymentType;
    res.locals.labelForPaymentMethod = labelForPaymentMethod;
    res.locals.labelForRole = labelForRole;
    res.locals.labelForAuditAction = labelForAuditAction;
    res.locals.labelForTableName = labelForTableName;
    res.locals.currentPath = req.path;
    res.locals.teamCrestUrl = (name) => {
      const slug = crestSlug(name);
      if (fs.existsSync(path.join(crestDir, `${slug}.svg`))) return `/img/crests/${slug}.svg`;
      if (fs.existsSync(path.join(crestDir, `${slug}.png`))) return `/img/crests/${slug}.png`;
      if (fs.existsSync(path.join(crestDir, `${slug}.gif`))) return `/img/crests/${slug}.gif`;
      if (fs.existsSync(path.join(crestDir, `${slug}.jpg`))) return `/img/crests/${slug}.jpg`;
      if (fs.existsSync(path.join(crestDir, `${slug}.jpeg`))) return `/img/crests/${slug}.jpeg`;
      if (fs.existsSync(path.join(crestDir, `${slug}.webp`))) return `/img/crests/${slug}.webp`;
      return null;
    };
    res.locals.isAdmin = user && ["admin", "super_admin"].includes(user.role);
    next();
  };
}

module.exports = { attachLocals };
