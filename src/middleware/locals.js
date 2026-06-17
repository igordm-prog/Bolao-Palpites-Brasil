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
  publicUser,
  todayIso
} = require("../utils");
const { audit } = require("../services/audit");

function crestSlug(name = "") {
  return String(name)
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");
}

const crestDir = path.join(__dirname, "..", "..", "public", "img", "crests");
const SESSION_IDLE_TIMEOUT_MS = 5 * 60 * 1000;

function isAdminUser(user) {
  return Boolean(user && ["admin", "super_admin"].includes(user.role));
}

function clearSessionFields(req) {
  delete req.session.userId;
  delete req.session.activeSessionToken;
  delete req.session.lastActivityAt;
  delete req.session.pendingWithdrawal;
  delete req.session.pendingLogin;
}

function clearUserActiveSession(user, sessionToken) {
  if (!user || user.activeSessionToken !== sessionToken) return;
  user.activeSessionToken = null;
  user.activeSessionStartedAt = null;
  user.activeSessionLastSeenAt = null;
  user.activeSessionExpiresAt = null;
  user.activeSessionDevice = null;
}

function buildNotifications(data, user, req) {
  if (!user) return [];
  const notifications = [];
  const participations = data.participations || [];
  const payments = data.payments || [];

  if (!user.emailVerifiedAt && user.status === "active") {
    notifications.push({
      title: "Valide seu e-mail",
      text: "Necessario para liberar saques.",
      href: "/app/carteira",
      tone: "warning"
    });
  }

  const openPools = (data.pools || []).filter((pool) => pool.status === "open");
  const newPools = openPools.filter(
    (pool) => !participations.some((item) => item.userId === user.id && item.poolId === pool.id)
  );
  newPools.slice(0, 3).forEach((pool) => {
    notifications.push({
      title: "Novo bolao disponivel",
      text: `${pool.name} esta aberto para participar.`,
      href: "/app/boloes",
      tone: "success"
    });
  });

  const pendingDeposit = payments.find(
    (payment) => payment.userId === user.id && payment.type === "deposit" && payment.status === "awaiting"
  );
  if (pendingDeposit) {
    notifications.push({
      title: "Deposito pendente",
      text: `${formatMoney(pendingDeposit.amount)} aguardando pagamento.`,
      href: `/app/pagamentos/${pendingDeposit.id}`,
      tone: "info"
    });
  }

  if (req.session.pendingWithdrawal) {
    notifications.push({
      title: "Confirme seu saque",
      text: "Digite o codigo enviado por e-mail.",
      href: "/app/carteira/saques/confirmar",
      tone: "warning"
    });
  }

  return notifications.slice(0, 6);
}

function attachLocals(store) {
  return (req, res, next) => {
    const data = store.read();
    let user = data.users.find((item) => item.id === req.session.userId);
    if (user && !req.session.activeSessionToken && req.path !== "/logout") {
      clearSessionFields(req);
      req.flash("error", "Sua sessao expirou. Entre novamente.");
      user = null;
      if (req.path !== "/login") return res.redirect("/login");
    }
    if (
      user &&
      !isAdminUser(user) &&
      req.session.activeSessionToken === user.activeSessionToken &&
      req.session.lastActivityAt
    ) {
      const inactiveFor = Date.now() - new Date(req.session.lastActivityAt).getTime();
      if (inactiveFor > SESSION_IDLE_TIMEOUT_MS) {
        clearUserActiveSession(user, req.session.activeSessionToken);
        audit(data, user.id, "auth.session_expired", "users", null, { inactiveForMs: inactiveFor }, req);
        store.write(data);
        clearSessionFields(req);
        req.flash("error", "Sessao expirada por inatividade. Entre novamente.");
        user = null;
        if (req.path !== "/login") return res.redirect("/login");
      }
    }
    if (user && req.session.activeSessionToken && !user.activeSessionToken && req.path !== "/logout") {
      clearSessionFields(req);
      req.flash("error", "Sua sessao expirou. Entre novamente.");
      user = null;
      if (req.path !== "/login") return res.redirect("/login");
    }
    if (user && user.activeSessionToken && req.session.activeSessionToken !== user.activeSessionToken && req.path !== "/logout") {
      clearSessionFields(req);
      req.flash("error", "Sua conta foi acessada em outro dispositivo e esta sessao foi encerrada.");
      return res.redirect("/login");
    }
    if (!user && req.session.userId) {
      clearSessionFields(req);
    }
    if (user && req.session.activeSessionToken === user.activeSessionToken) {
      const now = todayIso();
      req.session.lastActivityAt = now;
      user.activeSessionLastSeenAt = now;
      store.write(data);
    }
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
    res.locals.navGamesHref = user ? "/app/boloes" : "/login";
    res.locals.navRankingHref = navPool ? `/app/boloes/${navPool.id}/ranking` : user ? "/app/conta" : "/login";
    res.locals.notifications = buildNotifications(data, user, req);
    res.locals.notificationCount = res.locals.notifications.length;
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
    res.locals.isAdmin = isAdminUser(user);
    next();
  };
}

module.exports = { attachLocals };
