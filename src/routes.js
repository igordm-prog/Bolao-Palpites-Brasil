const crypto = require("crypto");
const bcrypt = require("bcryptjs");
const express = require("express");

const { requireAuth, requireAdmin } = require("./middleware/auth");
const { createPixDepositCharge, createPixWithdrawalTransfer, getAsaasPayment, isAsaasEnabled } = require("./services/asaas");
const { audit } = require("./services/audit");
const { dashboardFromSofaScoreSnapshot, getLiveEntriesDashboard, isSofaScoreLiveGame, refreshLiveEntries } = require("./services/liveEntries");
const { runSofaScoreBrowserProbe } = require("./services/sofascoreBrowser");
const {
  isEmailEnabled,
  sendEmailVerificationCode,
  sendLoginAccessCode,
  sendPasswordResetCode,
  sendRegistrationConfirmationLink,
  sendWithdrawalCode
} = require("./services/mailer");
const { recalculatePool, rankingForPool } = require("./services/scoring");
const { championships, isKnownTeam, teams } = require("./teams");
const {
  hashCpf,
  isAdult,
  isValidCpf,
  isValidEmail,
  isValidFullName,
  isValidPhone,
  isReasonableBirthDate,
  isWeekend,
  maskCpf,
  normalizeBirthDate,
  onlyDigits,
  labelForStatus,
  strongPassword,
  todayIso
} = require("./utils");

const paymentStatuses = ["awaiting", "paid", "canceled", "refunded", "expired"];

function getCurrentUser(data, req) {
  return data.users.find((user) => user.id === req.session.userId);
}

function recoveryCodeHash(token, code) {
  return crypto.createHash("sha256").update(`${token}:${code}`).digest("hex");
}

function tokenHash(token) {
  return crypto.createHash("sha256").update(String(token)).digest("hex");
}

function generateRecoveryCode() {
  return String(crypto.randomInt(100000, 1000000));
}

function appUrl() {
  return String(process.env.APP_URL || "http://localhost:3000").replace(/\/$/, "");
}

function maskEmailAddress(email = "") {
  const [name = "", domain = ""] = String(email).split("@");
  if (!name || !domain) return "e-mail cadastrado";
  return `${name.slice(0, 2)}***@${domain}`;
}

function recoveryDestinationLabel(user) {
  return maskEmailAddress(user.email);
}

function recoveryMethodLabel(method) {
  const labels = {
    email: "E-mail",
    cpf: "CPF"
  };
  return labels[method] || "E-mail";
}

function findUserForRecovery(data, method, identifier) {
  const normalized = String(identifier || "").trim().toLowerCase();
  if (method === "email") {
    return data.users.find((user) => user.email === normalized);
  }
  if (method === "cpf") {
    const digits = onlyDigits(identifier);
    if (!isValidCpf(digits)) return null;
    const cpfHash = hashCpf(digits);
    return data.users.find((user) => user.cpfHash === cpfHash);
  }
  return null;
}

function recoveryTestMessage(code, destination) {
  return `Codigo de teste enviado por e-mail para ${destination}: ${code}`;
}

function currentDeviceLabel(req) {
  const agent = String(req.get("user-agent") || "Dispositivo nao identificado").slice(0, 180);
  const ip = req.ip || req.socket?.remoteAddress || "IP nao identificado";
  return { userAgent: agent, ip };
}

function activeSessionIsValid(user) {
  return Boolean(user.activeSessionToken && (!user.activeSessionExpiresAt || new Date(user.activeSessionExpiresAt) > new Date()));
}

function recordSessionConflict(user) {
  const tenMinutesAgo = Date.now() - 10 * 60 * 1000;
  user.sessionConflictAttempts = (user.sessionConflictAttempts || []).filter(
    (timestamp) => new Date(timestamp).getTime() >= tenMinutesAgo
  );
  user.sessionConflictAttempts.push(todayIso());
  return user.sessionConflictAttempts.length;
}

function startPendingLogin(req, user, options = {}) {
  req.session.pendingLogin = {
    userId: user.id,
    requiresCode: Boolean(options.requiresCode),
    token: options.token || null,
    codeHash: options.codeHash || null,
    attempts: 0,
    expiresAt: new Date(Date.now() + 10 * 60 * 1000).toISOString()
  };
}

function pendingLoginIsValid(req) {
  const pending = req.session.pendingLogin;
  return Boolean(pending?.userId && pending.expiresAt && new Date(pending.expiresAt) > new Date());
}

function finishLogin(req, user, data, options = {}) {
  const sessionToken = crypto.randomBytes(32).toString("hex");
  const device = currentDeviceLabel(req);
  user.failedLoginCount = 0;
  user.lockedUntil = null;
  user.lastLoginAt = todayIso();
  user.activeSessionToken = sessionToken;
  user.activeSessionStartedAt = user.lastLoginAt;
  user.activeSessionLastSeenAt = user.lastLoginAt;
  user.activeSessionExpiresAt = new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString();
  user.activeSessionDevice = device;
  user.sessionConflictAttempts = (user.sessionConflictAttempts || []).filter(
    (timestamp) => Date.now() - new Date(timestamp).getTime() <= 10 * 60 * 1000
  );
  req.session.userId = user.id;
  req.session.activeSessionToken = sessionToken;
  req.session.lastActivityAt = user.lastLoginAt;
  delete req.session.pendingLogin;
  audit(data, user.id, options.replaced ? "auth.session_replaced" : "auth.login_success", "users", null, {
    lastLoginAt: user.lastLoginAt,
    device
  }, req);
}

function normalizeData(data) {
  data.settings ||= {};
  data.settings.appName = "Bolao Palpites Brasil";
  data.settings.domain = "bolaopalpitesbrasil.com.br";
  if (!data.settings.pixKey || data.settings.pixKey === "pix@bolaobrasilplacares.com.br") {
    data.settings.pixKey = "pix@bolaopalpitesbrasil.com.br";
  }
  data.settings.withdrawalMinimum = 20;
  data.settings.sofascoreBrowserLastResult ||= null;
  data.payments ||= [];
  data.participations ||= [];
  data.sofascoreSnapshots ||= [];
  data.sofascoreSnapshots.forEach((snapshot) => {
    snapshot.games ||= [];
    snapshot.lines ||= [];
    snapshot.createdAt ||= snapshot.finishedAt || todayIso();
    snapshot.gamesCount = Number(snapshot.gamesCount ?? snapshot.games.length);
    snapshot.liveGamesCount = Number(snapshot.liveGamesCount ?? snapshot.games.filter(isSofaScoreLiveGame).length);
  });
  data.users.forEach((user) => {
    user.walletBalance = Number(user.walletBalance || 0);
    user.emailVerifiedAt ||= null;
    user.emailVerification ||= null;
    user.sessionConflictAttempts ||= [];
  });
  data.payments.forEach((payment) => {
    payment.type ||= payment.poolId ? "pool_entry" : "deposit";
    payment.amount = Number(payment.amount || 0);
  });
}

function latestSofaScoreSnapshot(data, options = {}) {
  return (data.sofascoreSnapshots || [])
    .filter((snapshot) => !options.onlyOk || snapshot.ok)
    .slice()
    .sort((a, b) => new Date(b.finishedAt || b.createdAt).getTime() - new Date(a.finishedAt || a.createdAt).getTime())[0] || null;
}

function normalizeSofaScoreBrowserUrl(value) {
  const raw = String(value || process.env.SOFASCORE_BROWSER_URL || "https://www.sofascore.com/pt/futebol/").trim();
  try {
    const url = new URL(raw);
    if (!/^https:$/.test(url.protocol) || !/(^|\.)sofascore\.com$/i.test(url.hostname)) return null;
    if (url.pathname === "/" || url.pathname === "/pt/" || !url.pathname) url.pathname = "/pt/futebol/";
    return url.toString();
  } catch {
    return null;
  }
}

function saveSofaScoreSnapshot(data, store, result, userId) {
  const games = (result.games || []).map((game, index) => ({
    id: `${Date.now()}-${index + 1}`,
    eventId: game.eventId || null,
    competition: game.competition || null,
    group: game.group || null,
    time: game.time,
    status: game.status,
    statusLabel: game.statusLabel || null,
    statusSource: game.statusSource || null,
    minute: Number(game.minute || 0),
    homeTeam: game.homeTeam,
    awayTeam: game.awayTeam,
    homeScore: game.homeScore,
    awayScore: game.awayScore,
    score: game.score || null,
    odds1x2: game.odds1x2 || null,
    liveOdd: game.liveOdd || null,
    href: game.href || null,
    stats: game.stats || null,
    rawText: game.rawText || null,
    rawLines: game.rawLines || [],
    capturedAt: result.finishedAt
  }));
  const snapshot = {
    id: store.nextId(data, "sofascoreSnapshots"),
    ok: Boolean(result.ok),
    provider: result.provider,
    sourceUrl: result.url,
    currentUrl: result.currentUrl,
    title: result.title,
    startedAt: result.startedAt,
    finishedAt: result.finishedAt,
    createdAt: todayIso(),
    createdBy: userId,
    textLength: Number(result.textLength || 0),
    gamesCount: games.length,
    liveGamesCount: games.filter(isSofaScoreLiveGame).length,
    games,
    lines: (result.lines || []).slice(0, 160),
    error: result.error || null
  };
  data.sofascoreSnapshots.push(snapshot);
  data.sofascoreSnapshots = data.sofascoreSnapshots
    .slice()
    .sort((a, b) => new Date(b.finishedAt || b.createdAt).getTime() - new Date(a.finishedAt || a.createdAt).getTime())
    .slice(0, 30)
    .sort((a, b) => a.id - b.id);
  data.settings.sofascoreBrowserLastResult = result;
  return snapshot;
}

async function updateSofaScoreCache(store, options = {}) {
  const url = normalizeSofaScoreBrowserUrl(options.url);
  if (!url) throw new Error("Use uma URL valida do SofaScore.");
  const result = await runSofaScoreBrowserProbe({ url });
  let snapshot;
  store.update((data) => {
    normalizeData(data);
    snapshot = saveSofaScoreSnapshot(data, store, result, options.userId || null);
    audit(data, options.userId || null, "sofascore_browser.cache_updated", "sofascoreSnapshots", null, {
      ok: result.ok,
      url: result.url,
      games: result.games.length,
      liveGames: snapshot.liveGamesCount,
      snapshotId: snapshot.id,
      source: options.source || "manual",
      error: result.error
    }, options.req || null);
  });
  return { result, snapshot };
}

function startSofaScoreAutoMonitor(store, options = {}) {
  if (process.env.SOFASCORE_AUTO_MONITOR === "false") {
    console.log("[SofaScore] Monitor automatico desativado por SOFASCORE_AUTO_MONITOR=false.");
    return { stop: () => {} };
  }
  const intervalMs = Math.max(120000, Number(options.intervalMs || process.env.SOFASCORE_AUTO_INTERVAL_MS || 120000));
  const startDelayMs = Math.max(10000, Number(options.startDelayMs || process.env.SOFASCORE_AUTO_START_DELAY_MS || 15000));
  let running = false;

  async function run(reason) {
    if (running) return;
    running = true;
    try {
      const { result, snapshot } = await updateSofaScoreCache(store, { source: `auto:${reason}` });
      const status = result.ok ? "ok" : `erro: ${result.error}`;
      const sampleStatuses = (snapshot.games || [])
        .slice(0, 8)
        .map((game) => `${game.homeTeam || "?"} ${game.status || "-"} ${game.statusLabel || ""}`.trim())
        .join(" | ");
      const statsCount = (snapshot.games || []).filter((game) => game.stats && !game.stats.estimated && !game.stats.unavailable).length;
      console.log(`[SofaScore] Cache automatico ${status}. Jogos ao vivo: ${snapshot.liveGamesCount}/${snapshot.gamesCount}. Estatisticas: ${statsCount}/${snapshot.gamesCount}.${sampleStatuses ? ` Status: ${sampleStatuses}` : ""}`);
    } catch (error) {
      console.error(`[SofaScore] Falha no monitor automatico: ${error.message}`);
    } finally {
      running = false;
    }
  }

  const firstRun = setTimeout(() => run("startup"), startDelayMs);
  const timer = setInterval(() => run("interval"), intervalMs);
  firstRun.unref?.();
  timer.unref?.();
  console.log(`[SofaScore] Monitor automatico ligado a cada ${Math.round(intervalMs / 1000)}s.`);
  return {
    stop: () => {
      clearTimeout(firstRun);
      clearInterval(timer);
    }
  };
}

function poolFinancials(data, pool) {
  const paidCount = data.participations.filter(
    (participation) => participation.poolId === pool.id && participation.status === "paid"
  ).length;
  const gross = paidCount * Number(pool.entryValue || 0);
  const adminFee = gross * (Number(pool.adminFeePercent || 0) / 100);
  return {
    paidCount,
    gross,
    adminFee,
    netPrize: gross - adminFee
  };
}

function isPoolAuditAvailable(pool) {
  return ["closed", "finished"].includes(pool.status) || new Date(pool.deadlineAt) <= new Date();
}

function buildPoolAuditSnapshot(data, pool, generatedAt = todayIso()) {
  const matches = data.matches
    .filter((match) => match.poolId === pool.id)
    .slice()
    .sort((a, b) => `${a.matchDate} ${a.matchTime}`.localeCompare(`${b.matchDate} ${b.matchTime}`))
    .map((match) => ({
      id: match.id,
      championship: match.championship,
      round: match.round,
      homeTeam: match.homeTeam,
      awayTeam: match.awayTeam,
      matchDate: match.matchDate,
      matchTime: match.matchTime,
      venue: match.venue,
      homeScore: match.homeScore,
      awayScore: match.awayScore,
      status: match.status
    }));

  const participants = data.participations
    .filter((participation) => participation.poolId === pool.id && participation.status === "paid")
    .slice()
    .sort((a, b) => a.id - b.id)
    .map((participation) => {
      const user = data.users.find((item) => item.id === participation.userId);
      return {
        participationId: participation.id,
        userId: participation.userId,
        name: user?.name || "Participante removido",
        cpfMasked: user?.cpfMasked || "***.***.***-**",
        joinedAt: participation.createdAt,
        guesses: matches.map((match) => {
          const guess = data.guesses.find(
            (item) => item.poolId === pool.id && item.matchId === match.id && item.userId === participation.userId
          );
          return {
            matchId: match.id,
            homeTeam: match.homeTeam,
            awayTeam: match.awayTeam,
            homeScore: guess?.homeScore ?? null,
            awayScore: guess?.awayScore ?? null,
            points: guess?.points ?? 0,
            category: guess?.category || "pending",
            savedAt: guess?.updatedAt || guess?.createdAt || null
          };
        })
      };
    });

  const payload = {
    version: 1,
    generatedAt,
    pool: {
      id: pool.id,
      name: pool.name,
      round: pool.round,
      status: pool.status,
      startsAt: pool.startsAt,
      deadlineAt: pool.deadlineAt,
      entryValue: Number(pool.entryValue || 0),
      adminFeePercent: Number(pool.adminFeePercent || 0),
      prizeModel: pool.prizeModel
    },
    financials: poolFinancials(data, pool),
    matches,
    participants,
    ranking: rankingForPool(data, pool.id)
  };
  const hash = crypto.createHash("sha256").update(JSON.stringify(payload)).digest("hex");
  return { generatedAt, hash, payload };
}

function ensurePoolAuditSnapshot(data, pool, actorId = null, req = null) {
  if (pool.auditSnapshot?.hash && pool.auditSnapshot?.payload) return pool.auditSnapshot;
  const snapshot = buildPoolAuditSnapshot(data, pool);
  pool.auditSnapshot = snapshot;
  audit(data, actorId, "pool.audit_generated", "pools", null, { id: pool.id, hash: snapshot.hash }, req);
  return snapshot;
}

function requirePaidParticipation(data, userId, poolId) {
  return data.participations.find(
    (participation) =>
      participation.userId === userId && participation.poolId === poolId && participation.status === "paid"
  );
}

function pixCodeForDeposit(data, amount, userId) {
  return `PIX|${data.settings.pixKey}|${Number(amount).toFixed(2)}|CARTEIRA-USER-${userId}-${Date.now()}`;
}

function applyAsaasPaymentStatus(data, payment, asaasPayment, event, req) {
  const before = {
    status: payment.status,
    creditedAt: payment.creditedAt,
    providerStatus: payment.providerStatus
  };
  payment.providerStatus = asaasPayment.status || payment.providerStatus;
  payment.updatedAt = todayIso();

  const paidEvents = ["PAYMENT_RECEIVED", "PAYMENT_CONFIRMED", "PAYMENT_RECEIVED_IN_CASH"];
  const paidStatuses = ["RECEIVED", "CONFIRMED", "RECEIVED_IN_CASH"];
  const expiredStatuses = ["OVERDUE", "DELETED"];
  const refundedStatuses = ["REFUNDED", "CHARGEBACK_REQUESTED", "CHARGEBACK_DISPUTE"];

  if (paidEvents.includes(event) || paidStatuses.includes(asaasPayment.status)) {
    payment.status = "paid";
    payment.transactionId = asaasPayment.id;
    payment.confirmedAt = payment.confirmedAt || todayIso();

    if (payment.type === "deposit" && !payment.creditedAt) {
      const user = data.users.find((item) => item.id === payment.userId);
      if (user) {
        const beforeBalance = Number(user.walletBalance || 0);
        user.walletBalance = beforeBalance + Number(payment.amount || 0);
        payment.creditedAt = todayIso();
        audit(
          data,
          null,
          "wallet.deposit_credited",
          "users",
          { id: user.id, walletBalance: beforeBalance },
          { id: user.id, walletBalance: user.walletBalance, paymentId: payment.id, providerPaymentId: asaasPayment.id },
          req
        );
      }
    }
  } else if (expiredStatuses.includes(asaasPayment.status)) {
    payment.status = "expired";
  } else if (refundedStatuses.includes(asaasPayment.status)) {
    payment.status = "refunded";
  }

  if (before.status !== payment.status || before.providerStatus !== payment.providerStatus) {
    audit(data, null, "payment.status_changed", "payments", before, payment, req);
  }

  return payment.status !== before.status || payment.providerStatus !== before.providerStatus || payment.creditedAt !== before.creditedAt;
}

function applyAsaasTransferStatus(data, payment, asaasTransfer, event, req) {
  const before = {
    status: payment.status,
    providerStatus: payment.providerStatus,
    refundedAt: payment.refundedAt,
    transactionId: payment.transactionId
  };

  payment.providerStatus = asaasTransfer.status || payment.providerStatus;
  payment.transferReceiptUrl = asaasTransfer.transactionReceiptUrl || payment.transferReceiptUrl || null;
  payment.endToEndIdentifier = asaasTransfer.endToEndIdentifier || payment.endToEndIdentifier || null;
  payment.updatedAt = todayIso();

  const doneEvents = ["TRANSFER_DONE"];
  const failedEvents = ["TRANSFER_FAILED", "TRANSFER_CANCELLED"];
  const doneStatuses = ["DONE"];
  const failedStatuses = ["FAILED", "CANCELLED"];

  if (doneEvents.includes(event) || doneStatuses.includes(asaasTransfer.status)) {
    payment.status = "paid";
    payment.transactionId = asaasTransfer.id || payment.transactionId;
    payment.confirmedAt = payment.confirmedAt || todayIso();
  } else if (failedEvents.includes(event) || failedStatuses.includes(asaasTransfer.status)) {
    if (payment.status !== "canceled" && payment.status !== "refunded") {
      const user = data.users.find((item) => item.id === payment.userId);
      if (user && payment.type === "withdrawal" && !payment.refundedAt) {
        const beforeBalance = Number(user.walletBalance || 0);
        user.walletBalance = beforeBalance + Number(payment.amount || 0);
        payment.refundedAt = todayIso();
        audit(
          data,
          null,
          "wallet.withdrawal_canceled",
          "users",
          { id: user.id, walletBalance: beforeBalance },
          { id: user.id, walletBalance: user.walletBalance, paymentId: payment.id, providerTransferId: asaasTransfer.id },
          req
        );
      }
    }
    payment.status = "canceled";
  }

  if (before.status !== payment.status || before.providerStatus !== payment.providerStatus) {
    audit(data, null, "payment.status_changed", "payments", before, payment, req);
  }

  return payment.status !== before.status || payment.providerStatus !== before.providerStatus || payment.refundedAt !== before.refundedAt;
}

function router(store) {
  const app = express.Router();

  app.get("/", (req, res) => {
    const data = store.read();
    normalizeData(data);
    res.render("home", { title: data.settings.appName });
  });

  app.get("/termos", (req, res) => res.render("legal/terms", { title: "Termos de Uso" }));
  app.get("/privacidade", (req, res) => res.render("legal/privacy", { title: "Política de Privacidade" }));
  app.get("/regras", (req, res) => res.render("legal/rules", { title: "Regras do Bolão" }));
  app.get("/premiacoes", (req, res) => {
    const data = store.read();
    normalizeData(data);
    const pools = data.pools.map((pool) => ({ ...pool, financials: poolFinancials(data, pool) }));
    const totals = pools.reduce(
      (acc, pool) => ({
        gross: acc.gross + pool.financials.gross,
        netPrize: acc.netPrize + pool.financials.netPrize,
        paidCount: acc.paidCount + pool.financials.paidCount
      }),
      { gross: 0, netPrize: 0, paidCount: 0 }
    );
    res.render("legal/prizes", { title: "Premiações", pools, totals });
  });

  app.get("/cadastro", (req, res) => res.render("auth/register", { title: "Cadastro" }));

  app.post("/cadastro", async (req, res) => {
    const data = store.read();
    normalizeData(data);
    const {
      name,
      cpf,
      birthDate,
      email,
      phone,
      password,
      confirmPassword,
      acceptedTerms,
      acceptedPrivacy,
      adultConfirmation
    } = req.body;
    const normalizedEmail = String(email || "").trim().toLowerCase();
    const normalizedCpf = onlyDigits(cpf);
    const normalizedBirthDate = normalizeBirthDate(birthDate);
    const normalizedName = String(name || "").trim().replace(/\s+/g, " ");
    const normalizedPhone = String(phone || "").trim();

    const errors = [];
    if (!normalizedName || !normalizedEmail || !normalizedPhone || !birthDate) errors.push("Preencha todos os dados obrigatorios.");
    if (birthDate && (!normalizedBirthDate || !isReasonableBirthDate(normalizedBirthDate))) {
      errors.push("Data de nascimento invalida. Informe uma data real entre 18 e 120 anos.");
    }
    if (!isValidFullName(normalizedName)) errors.push("Informe nome e sobrenome validos, sem numeros ou simbolos.");
    if (!isValidEmail(normalizedEmail)) errors.push("E-mail invalido.");
    if (!isValidPhone(normalizedPhone)) errors.push("Telefone/WhatsApp invalido.");
    if (!isValidCpf(normalizedCpf)) errors.push("CPF invalido.");
    if (!isAdult(normalizedBirthDate) || adultConfirmation !== "on") errors.push("E necessario confirmar maioridade.");
    if (!strongPassword(password)) {
      errors.push("A senha precisa ter 8 caracteres, maiuscula, minuscula, numero e caractere especial.");
    }
    if (password !== confirmPassword) errors.push("A confirmacao de senha nao confere.");
    if (acceptedTerms !== "on" || acceptedPrivacy !== "on") errors.push("Aceite os termos e a privacidade.");
    if (data.users.some((user) => user.email === normalizedEmail)) errors.push("E-mail ja cadastrado.");
    if (data.users.some((user) => user.cpfHash === hashCpf(normalizedCpf))) errors.push("CPF ja cadastrado.");
    if (errors.length) {
      errors.forEach((message) => req.flash("error", message));
      return res.redirect("/cadastro");
    }

    const passwordHash = await bcrypt.hash(password, 12);
    const confirmationToken = crypto.randomBytes(28).toString("hex");
    const user = {
      id: store.nextId(data, "users"),
      name: normalizedName,
      cpfHash: hashCpf(normalizedCpf),
      cpfMasked: maskCpf(normalizedCpf),
      billingCpfCnpj: normalizedCpf,
      birthDate: normalizedBirthDate,
      email: normalizedEmail,
      phone: normalizedPhone,
      passwordHash,
      role: "user",
      status: "awaiting_email",
      walletBalance: 0,
      emailVerifiedAt: null,
      emailVerification: {
        purpose: "registration",
        tokenHash: tokenHash(confirmationToken),
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
        createdAt: todayIso()
      },
      acceptedTermsAt: todayIso(),
      acceptedPrivacyAt: todayIso(),
      lastLoginAt: null,
      failedLoginCount: 0,
      lockedUntil: null,
      createdAt: todayIso()
    };
    data.users.push(user);
    audit(data, user.id, "user.registered", "users", null, { id: user.id, email: user.email }, req);
    store.write(data);
    const confirmationLink = `${appUrl()}/confirmar-email/${confirmationToken}`;
    if (isEmailEnabled()) {
      try {
        await sendRegistrationConfirmationLink(user, confirmationLink);
        req.flash("success", "Cadastro criado. Enviamos um link de confirmacao para seu e-mail.");
      } catch (error) {
        req.flash("error", `Nao foi possivel enviar o e-mail de confirmacao agora: ${error.message}`);
        req.flash("success", `Link de teste para confirmar cadastro: ${confirmationLink}`);
      }
    } else {
      req.flash("success", "Cadastro criado. SMTP ainda nao configurado, use o link de teste abaixo para confirmar.");
      req.flash("success", `Link de teste para confirmar cadastro: ${confirmationLink}`);
    }
    return res.redirect("/login");
  });

  app.get("/confirmar-email/:token", (req, res) => {
    const data = store.read();
    normalizeData(data);
    const hashedToken = tokenHash(req.params.token);
    const user = data.users.find(
      (item) =>
        item.emailVerification?.purpose === "registration" &&
        item.emailVerification?.tokenHash === hashedToken
    );
    if (!user || new Date(user.emailVerification.expiresAt) < new Date()) {
      return res.status(400).render("status", {
        title: "Link expirado",
        message: "Este link de confirmacao expirou. Solicite suporte ou faca um novo cadastro.",
        actionHref: "/login",
        actionLabel: "Ir para login"
      });
    }

    user.emailVerifiedAt = todayIso();
    user.emailVerification = null;
    if (user.status === "awaiting_email") user.status = "active";
    audit(data, user.id, "user.email_verified", "users", null, { id: user.id, email: user.email, source: "registration" }, req);
    store.write(data);
    req.flash("success", "E-mail confirmado. Agora voce pode entrar no site.");
    return res.redirect("/login");
  });

  app.get("/login", (req, res) => res.render("auth/login", { title: "Entrar" }));

  app.post("/login", async (req, res) => {
    const identifier = String(req.body.identifier || "").trim().toLowerCase();
    const password = String(req.body.password || "");
    const data = store.read();
    normalizeData(data);
    const cpfCandidate = onlyDigits(identifier);
    const user = data.users.find(
      (item) => item.email === identifier || (cpfCandidate.length === 11 && item.cpfHash === hashCpf(cpfCandidate))
    );

    if (!user) {
      req.flash("error", "Usuario ou senha invalidos.");
      return res.redirect("/login");
    }
    if (user.status !== "active") {
      if (user.status === "awaiting_email") {
        req.flash("error", "Confirme o cadastro pelo link enviado ao seu e-mail antes de entrar.");
        return res.redirect("/login");
      }
      req.flash("error", "Conta bloqueada. Entre em contato com o suporte.");
      return res.redirect("/login");
    }
    if (user.lockedUntil && new Date(user.lockedUntil) > new Date()) {
      req.flash("error", "Muitas tentativas. Tente novamente mais tarde.");
      return res.redirect("/login");
    }

    const ok = await bcrypt.compare(password, user.passwordHash);
    if (!ok) {
      user.failedLoginCount = (user.failedLoginCount || 0) + 1;
      if (user.failedLoginCount >= 5) {
        user.lockedUntil = new Date(Date.now() + 15 * 60 * 1000).toISOString();
      }
      audit(data, user.id, "auth.login_failed", "users", null, { failedLoginCount: user.failedLoginCount }, req);
      store.write(data);
      req.flash("error", "Usuario ou senha invalidos.");
      return res.redirect("/login");
    }

    user.failedLoginCount = 0;
    user.lockedUntil = null;
    if (activeSessionIsValid(user) && req.session.activeSessionToken !== user.activeSessionToken) {
      const conflictCount = recordSessionConflict(user);
      const requiresCode = conflictCount > 4;
      let code = null;
      let token = null;
      if (requiresCode) {
        token = crypto.randomBytes(24).toString("hex");
        code = generateRecoveryCode();
      }
      startPendingLogin(req, user, {
        requiresCode,
        token,
        codeHash: code ? recoveryCodeHash(token, code) : null
      });
      audit(data, user.id, "auth.concurrent_login_attempt", "users", null, {
        conflictCount,
        requiresCode,
        currentDevice: currentDeviceLabel(req),
        activeDevice: user.activeSessionDevice || null
      }, req);
      store.write(data);
      if (requiresCode) {
        if (isEmailEnabled()) {
          try {
            await sendLoginAccessCode(user, code);
            req.flash("success", `Enviamos um codigo de seguranca para ${maskEmailAddress(user.email)}.`);
          } catch (error) {
            req.flash("error", "Nao foi possivel enviar o codigo por e-mail. Verifique a configuracao SMTP.");
          }
        } else {
          req.flash("success", `Codigo de teste para autorizar novo dispositivo: ${code}`);
        }
      } else {
        req.flash("error", "Esta conta ja esta logada em outro dispositivo.");
      }
      return res.redirect("/login/dispositivo");
    }

    finishLogin(req, user, data);
    store.write(data);
    return res.redirect(["admin", "super_admin"].includes(user.role) ? "/admin" : "/app");
  });

  app.get("/login/dispositivo", (req, res) => {
    const data = store.read();
    normalizeData(data);
    const pending = pendingLoginIsValid(req) ? req.session.pendingLogin : null;
    if (!pending) {
      delete req.session.pendingLogin;
      req.flash("error", "A verificacao expirou. Entre novamente.");
      return res.redirect("/login");
    }
    const user = data.users.find((item) => item.id === pending.userId);
    if (!user) {
      delete req.session.pendingLogin;
      return res.redirect("/login");
    }
    return res.render("auth/device-login", {
      title: "Confirmar dispositivo",
      pending,
      user,
      activeDevice: user.activeSessionDevice || null,
      destination: maskEmailAddress(user.email),
      attemptsLeft: Math.max(0, 5 - Number(pending.attempts || 0))
    });
  });

  app.post("/login/dispositivo/encerrar", (req, res) => {
    const data = store.read();
    normalizeData(data);
    const pending = pendingLoginIsValid(req) ? req.session.pendingLogin : null;
    if (!pending || pending.requiresCode) {
      delete req.session.pendingLogin;
      req.flash("error", "A verificacao expirou. Entre novamente.");
      return res.redirect("/login");
    }
    const user = data.users.find((item) => item.id === pending.userId && item.status === "active");
    if (!user) {
      delete req.session.pendingLogin;
      req.flash("error", "Conta indisponivel.");
      return res.redirect("/login");
    }
    finishLogin(req, user, data, { replaced: true });
    store.write(data);
    req.flash("success", "Sessao anterior encerrada. Acesso liberado neste dispositivo.");
    return res.redirect(["admin", "super_admin"].includes(user.role) ? "/admin" : "/app");
  });

  app.post("/login/dispositivo/codigo", (req, res) => {
    const data = store.read();
    normalizeData(data);
    const pending = pendingLoginIsValid(req) ? req.session.pendingLogin : null;
    const code = onlyDigits(req.body.code).slice(0, 6);
    if (!pending || !pending.requiresCode) {
      delete req.session.pendingLogin;
      req.flash("error", "A verificacao expirou. Entre novamente.");
      return res.redirect("/login");
    }
    const user = data.users.find((item) => item.id === pending.userId && item.status === "active");
    if (!user) {
      delete req.session.pendingLogin;
      req.flash("error", "Conta indisponivel.");
      return res.redirect("/login");
    }
    pending.attempts = Number(pending.attempts || 0);
    if (pending.attempts >= 5) {
      delete req.session.pendingLogin;
      req.flash("error", "Muitas tentativas de codigo. Entre novamente.");
      return res.redirect("/login");
    }
    if (code.length !== 6 || pending.codeHash !== recoveryCodeHash(pending.token, code)) {
      pending.attempts += 1;
      req.flash("error", "Codigo invalido.");
      return res.redirect("/login/dispositivo");
    }
    finishLogin(req, user, data, { replaced: true });
    audit(data, user.id, "auth.login_code_verified", "users", null, { device: currentDeviceLabel(req) }, req);
    store.write(data);
    req.flash("success", "Codigo confirmado. Sessao anterior encerrada.");
    return res.redirect(["admin", "super_admin"].includes(user.role) ? "/admin" : "/app");
  });

  app.post("/logout", (req, res) => {
    const sessionUserId = req.session.userId;
    const sessionToken = req.session.activeSessionToken;
    if (sessionUserId && sessionToken) {
      const data = store.read();
      normalizeData(data);
      const user = data.users.find((item) => item.id === sessionUserId);
      if (user && user.activeSessionToken === sessionToken) {
        user.activeSessionToken = null;
        user.activeSessionStartedAt = null;
        user.activeSessionLastSeenAt = null;
        user.activeSessionExpiresAt = null;
        user.activeSessionDevice = null;
        audit(data, user.id, "auth.logout", "users", null, { id: user.id }, req);
        store.write(data);
      }
    }
    req.session.destroy(() => res.redirect("/"));
  });

  app.get("/recuperar", (req, res) => res.render("auth/recover", { title: "Recuperar senha" }));

  app.post("/recuperar", async (req, res) => {
    const method = ["email", "cpf"].includes(req.body.method) ? req.body.method : "email";
    const identifier = String(req.body.identifier || "").trim();
    const data = store.read();
    normalizeData(data);
    const user = findUserForRecovery(data, method, identifier);
    if (user) {
      const token = crypto.randomBytes(24).toString("hex");
      const code = generateRecoveryCode();
      const destination = recoveryDestinationLabel(user);
      data.passwordResets.push({
        id: store.nextId(data, "passwordResets"),
        userId: user.id,
        token,
        codeHash: recoveryCodeHash(token, code),
        method,
        deliveryChannel: "email",
        destinationMasked: destination,
        attempts: 0,
        expiresAt: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
        verifiedAt: null,
        usedAt: null,
        createdAt: todayIso()
      });
      audit(data, user.id, "auth.password_reset_requested", "passwordResets", null, { method, destination }, req);
      store.write(data);
      if (isEmailEnabled()) {
        try {
          await sendPasswordResetCode(user, code);
          req.flash("success", `Enviamos um codigo de 6 digitos para ${destination}.`);
        } catch (error) {
          req.flash("error", `Nao foi possivel enviar o e-mail agora: ${error.message}`);
          req.flash("success", recoveryTestMessage(code, destination));
        }
      } else {
        req.flash("success", "SMTP ainda nao configurado. Use o codigo de teste abaixo para validar o fluxo.");
        req.flash("success", recoveryTestMessage(code, destination));
      }
      return res.redirect(`/recuperar/codigo/${token}`);
    } else {
      req.flash("success", "Se os dados existirem, enviaremos as instrucoes de recuperacao.");
    }
    return res.redirect("/recuperar");
  });

  app.get("/recuperar/codigo/:token", (req, res) => {
    const data = store.read();
    normalizeData(data);
    const reset = data.passwordResets.find((item) => item.token === req.params.token && !item.usedAt);
    if (!reset || new Date(reset.expiresAt) < new Date()) {
      return res.status(400).render("status", {
        title: "Codigo expirado",
        message: "Solicite uma nova recuperacao de senha.",
        actionHref: "/recuperar",
        actionLabel: "Recuperar senha"
      });
    }
    return res.render("auth/confirm-reset", {
      title: "Confirmar codigo",
      token: req.params.token,
      methodLabel: recoveryMethodLabel(reset.method),
      destination: reset.destinationMasked || "destino cadastrado",
      attemptsLeft: Math.max(0, 5 - Number(reset.attempts || 0))
    });
  });

  app.post("/recuperar/codigo/:token", (req, res) => {
    const code = onlyDigits(req.body.code).slice(0, 6);
    const data = store.read();
    normalizeData(data);
    const reset = data.passwordResets.find((item) => item.token === req.params.token && !item.usedAt);
    if (!reset || new Date(reset.expiresAt) < new Date()) {
      req.flash("error", "Codigo expirado. Solicite uma nova recuperacao.");
      return res.redirect("/recuperar");
    }

    reset.attempts = Number(reset.attempts || 0);
    if (reset.attempts >= 5) {
      req.flash("error", "Muitas tentativas. Solicite um novo codigo.");
      store.write(data);
      return res.redirect("/recuperar");
    }

    if (code.length !== 6 || reset.codeHash !== recoveryCodeHash(reset.token, code)) {
      reset.attempts += 1;
      store.write(data);
      req.flash("error", "Codigo invalido.");
      return res.redirect(`/recuperar/codigo/${req.params.token}`);
    }

    reset.verifiedAt = todayIso();
    store.write(data);
    req.flash("success", "Codigo confirmado. Crie sua nova senha.");
    return res.redirect(`/redefinir/${req.params.token}`);
  });

  app.post("/webhooks/asaas", (req, res) => {
    const expectedToken = process.env.ASAAS_WEBHOOK_TOKEN;
    if (expectedToken && req.get("asaas-access-token") !== expectedToken) {
      return res.status(401).json({ ok: false });
    }

    const data = store.read();
    normalizeData(data);

    if (req.body?.type === "TRANSFER" && req.body?.transfer) {
      const transfer = req.body.transfer;
      const payment = data.payments.find(
        (item) =>
          item.type === "withdrawal" &&
          item.provider === "asaas" &&
          (item.providerTransferId === transfer.id || item.externalReference === transfer.externalReference) &&
          Number(item.amount || 0) === Number(transfer.value || 0)
      );
      if (!payment) {
        return res.json({ status: "REFUSED", refuseReason: "Transferencia nao encontrada no sistema." });
      }
      applyAsaasTransferStatus(data, payment, transfer, "TRANSFER_VALIDATION", req);
      store.write(data);
      return res.json({ status: "APPROVED" });
    }

    const event = req.body?.event;
    const asaasTransfer = req.body?.transfer || {};
    const providerTransferId = asaasTransfer.id;
    if (providerTransferId) {
      const payment = data.payments.find(
        (item) =>
          item.type === "withdrawal" &&
          item.provider === "asaas" &&
          (item.providerTransferId === providerTransferId || item.externalReference === asaasTransfer.externalReference)
      );
      if (!payment) return res.json({ ok: true });
      applyAsaasTransferStatus(data, payment, asaasTransfer, event, req);
      store.write(data);
      return res.json({ ok: true });
    }

    const asaasPayment = req.body?.payment || {};
    const providerPaymentId = asaasPayment.id;
    if (!providerPaymentId) return res.json({ ok: true });

    const payment = data.payments.find(
      (item) => item.provider === "asaas" && item.providerPaymentId === providerPaymentId
    );
    if (!payment) return res.json({ ok: true });

    applyAsaasPaymentStatus(data, payment, asaasPayment, event, req);
    store.write(data);
    return res.json({ ok: true });
  });

  app.get("/redefinir/:token", (req, res) => {
    const data = store.read();
    normalizeData(data);
    const reset = data.passwordResets.find((item) => item.token === req.params.token && !item.usedAt);
    if (!reset || new Date(reset.expiresAt) < new Date()) {
      return res.status(400).render("status", {
        title: "Link expirado",
        message: "Solicite uma nova recuperacao de senha.",
        actionHref: "/recuperar",
        actionLabel: "Recuperar senha"
      });
    }
    if (reset.codeHash && !reset.verifiedAt) {
      req.flash("error", "Confirme o codigo antes de criar a nova senha.");
      return res.redirect(`/recuperar/codigo/${req.params.token}`);
    }
    return res.render("auth/reset", { title: "Nova senha", token: req.params.token });
  });

  app.post("/redefinir/:token", async (req, res) => {
    const { password, confirmPassword } = req.body;
    if (!strongPassword(password) || password !== confirmPassword) {
      req.flash("error", "Informe uma senha forte e confirme corretamente.");
      return res.redirect(`/redefinir/${req.params.token}`);
    }
    const data = store.read();
    normalizeData(data);
    const reset = data.passwordResets.find((item) => item.token === req.params.token && !item.usedAt);
    if (!reset || new Date(reset.expiresAt) < new Date()) {
      req.flash("error", "Link expirado.");
      return res.redirect("/recuperar");
    }
    if (reset.codeHash && !reset.verifiedAt) {
      req.flash("error", "Confirme o codigo antes de criar a nova senha.");
      return res.redirect(`/recuperar/codigo/${req.params.token}`);
    }
    const user = data.users.find((item) => item.id === reset.userId);
    user.passwordHash = await bcrypt.hash(password, 12);
    reset.usedAt = todayIso();
    audit(data, user.id, "auth.password_reset_completed", "users", null, { id: user.id }, req);
    store.write(data);
    req.flash("success", "Senha redefinida. Entre novamente.");
    return res.redirect("/login");
  });

  app.get("/app", requireAuth, (req, res) => {
    return res.redirect("/app/conta");
  });

  app.get("/app/boloes", requireAuth, (req, res) => {
    const data = store.read();
    normalizeData(data);
    const user = getCurrentUser(data, req);
    const participations = data.participations.filter((item) => item.userId === user.id);
    const pools = data.pools
      .map((pool) => ({
        ...pool,
        financials: poolFinancials(data, pool),
        matchesCount: data.matches.filter((match) => match.poolId === pool.id).length,
        participation: participations.find((item) => item.poolId === pool.id) || null,
        auditAvailable: isPoolAuditAvailable(pool),
        auditSnapshot: pool.auditSnapshot || null
      }))
      .sort((a, b) => {
        const order = { open: 0, draft: 1, closed: 2, finished: 3, canceled: 4 };
        return (order[a.status] ?? 9) - (order[b.status] ?? 9) || new Date(b.deadlineAt) - new Date(a.deadlineAt);
      });
    res.render("app/pools", { title: "Boloes", user, pools });
  });

  app.get("/app/entradas-ao-vivo", requireAuth, async (req, res) => {
    const data = store.read();
    normalizeData(data);
    const user = getCurrentUser(data, req);
    const liveEntries = dashboardFromSofaScoreSnapshot(latestSofaScoreSnapshot(data, { onlyOk: true })) || await getLiveEntriesDashboard();
    res.render("app/live-entries", { title: "Entradas ao vivo", user, liveEntries });
  });

  app.get("/app/entradas-ao-vivo/dados", requireAuth, async (req, res) => {
    const data = store.read();
    normalizeData(data);
    const liveEntries = dashboardFromSofaScoreSnapshot(latestSofaScoreSnapshot(data, { onlyOk: true })) || await getLiveEntriesDashboard({ maxAgeMs: 5000 });
    res.json(liveEntries);
  });

  app.post("/app/entradas-ao-vivo/atualizar", requireAuth, async (req, res) => {
    const data = store.read();
    normalizeData(data);
    const liveEntries = dashboardFromSofaScoreSnapshot(latestSofaScoreSnapshot(data, { onlyOk: true })) || await refreshLiveEntries();
    res.json(liveEntries);
  });

  app.get("/app/conta", requireAuth, (req, res) => {
    const data = store.read();
    normalizeData(data);
    const user = getCurrentUser(data, req);
    const pools = data.pools.map((pool) => ({ ...pool, financials: poolFinancials(data, pool) }));
    const participations = data.participations.filter((item) => item.userId === user.id);
    const payments = data.payments.filter((item) => item.userId === user.id);
    res.render("app/dashboard", { title: "Conta", user, pools, participations, payments });
  });

  app.get("/app/carteira", requireAuth, (req, res) => {
    const data = store.read();
    normalizeData(data);
    const user = getCurrentUser(data, req);
    const payments = data.payments
      .filter((item) => item.userId === user.id)
      .slice()
      .reverse();
    res.render("app/wallet", { title: "Minha carteira", user, payments });
  });

  app.post("/app/email/verificacao/enviar", requireAuth, async (req, res) => {
    const data = store.read();
    normalizeData(data);
    const user = getCurrentUser(data, req);
    const token = crypto.randomBytes(18).toString("hex");
    const code = generateRecoveryCode();
    const destination = maskEmailAddress(user.email);
    user.emailVerification = {
      token,
      codeHash: recoveryCodeHash(token, code),
      attempts: 0,
      expiresAt: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
      createdAt: todayIso()
    };
    store.write(data);

    if (isEmailEnabled()) {
      try {
        await sendEmailVerificationCode(user, code);
        req.flash("success", `Enviamos um codigo para ${destination}.`);
      } catch (error) {
        req.flash("error", `Nao foi possivel enviar o e-mail agora: ${error.message}`);
        req.flash("success", `Codigo de teste para validar e-mail em ${destination}: ${code}`);
      }
    } else {
      req.flash("success", "SMTP ainda nao configurado. Use o codigo de teste abaixo para validar o e-mail.");
      req.flash("success", `Codigo de teste para validar e-mail em ${destination}: ${code}`);
    }
    return res.redirect("/app/carteira");
  });

  app.post("/app/email/verificacao/confirmar", requireAuth, (req, res) => {
    const code = onlyDigits(req.body.code).slice(0, 6);
    const data = store.read();
    normalizeData(data);
    const user = getCurrentUser(data, req);
    const verification = user.emailVerification;

    if (!verification || new Date(verification.expiresAt) < new Date()) {
      req.flash("error", "Codigo de e-mail expirado. Solicite um novo codigo.");
      return res.redirect("/app/carteira");
    }

    verification.attempts = Number(verification.attempts || 0);
    if (verification.attempts >= 5) {
      user.emailVerification = null;
      store.write(data);
      req.flash("error", "Muitas tentativas. Solicite um novo codigo.");
      return res.redirect("/app/carteira");
    }

    if (code.length !== 6 || verification.codeHash !== recoveryCodeHash(verification.token, code)) {
      verification.attempts += 1;
      store.write(data);
      req.flash("error", "Codigo de e-mail invalido.");
      return res.redirect("/app/carteira");
    }

    user.emailVerifiedAt = todayIso();
    user.emailVerification = null;
    audit(data, user.id, "user.email_verified", "users", null, { id: user.id, email: user.email }, req);
    store.write(data);
    req.flash("success", "E-mail validado com sucesso. Saques liberados com confirmacao por codigo.");
    return res.redirect("/app/carteira");
  });

  app.get(["/historico", "/app/historico"], requireAuth, (req, res) => {
    const data = store.read();
    normalizeData(data);
    const user = getCurrentUser(data, req);
    const participations = data.participations
      .filter((item) => item.userId === user.id)
      .map((participation) => {
        const pool = data.pools.find((item) => item.id === participation.poolId);
        const guesses = data.guesses.filter((guess) => guess.poolId === participation.poolId && guess.userId === user.id);
        const ranking = pool ? rankingForPool(data, pool.id) : [];
        const rank = ranking.find((row) => row.userId === user.id);
        return {
          ...participation,
          pool,
          guesses,
          rankingPosition: rank?.position || null,
          totalPoints: rank?.total || 0,
          exact: rank?.exact || 0,
          result: rank?.result || 0,
          side: rank?.side || 0
        };
      })
      .reverse();
    const payments = data.payments
      .filter((item) => item.userId === user.id)
      .map((payment) => ({ ...payment, pool: data.pools.find((pool) => pool.id === payment.poolId) }))
      .reverse();
    const totals = {
      paidEntries: payments.filter((payment) => payment.type === "pool_entry" && payment.status === "paid").length,
      deposits: payments.filter((payment) => payment.type === "deposit" && payment.status === "paid").reduce((sum, payment) => sum + Number(payment.amount || 0), 0),
      withdrawals: payments.filter((payment) => payment.type === "withdrawal" && payment.status === "paid").reduce((sum, payment) => sum + Number(payment.amount || 0), 0),
      spent: payments.filter((payment) => payment.type === "pool_entry" && payment.status === "paid").reduce((sum, payment) => sum + Number(payment.amount || 0), 0),
      guesses: data.guesses.filter((guess) => guess.userId === user.id).length
    };
    res.render("app/history", { title: "Histórico", user, participations, payments, totals });
  });

  app.post("/app/carteira/depositos", requireAuth, async (req, res) => {
    const data = store.read();
    normalizeData(data);
    const user = getCurrentUser(data, req);
    const amount = Number(req.body.amount);
    const billingCpfCnpj = onlyDigits(req.body.billingCpfCnpj || user.billingCpfCnpj || "");
    if (!Number.isFinite(amount) || amount < Number(data.settings.depositMinimum || 0)) {
      req.flash("error", `O deposito minimo e ${res.locals.formatMoney(data.settings.depositMinimum)}.`);
      return res.redirect("/app/carteira");
    }
    if (isAsaasEnabled() && ![11, 14].includes(billingCpfCnpj.length)) {
      req.flash("error", "Informe o CPF ou CNPJ do titular para gerar o PIX automatico.");
      return res.redirect("/app/carteira");
    }
    if (billingCpfCnpj) user.billingCpfCnpj = billingCpfCnpj;
    const payment = {
      id: store.nextId(data, "payments"),
      type: "deposit",
      userId: user.id,
      poolId: null,
      participationId: null,
      amount,
      status: "awaiting",
      method: "PIX",
      pixCode: pixCodeForDeposit(data, amount, user.id),
      pixEncodedImage: null,
      pixExpirationDate: null,
      provider: isAsaasEnabled() ? "asaas" : "manual",
      providerPaymentId: null,
      providerStatus: null,
      externalReference: null,
      invoiceUrl: null,
      transactionId: null,
      createdAt: todayIso(),
      updatedAt: todayIso(),
      confirmedAt: null,
      creditedAt: null
    };

    if (isAsaasEnabled()) {
      try {
        await createPixDepositCharge(data, user, payment);
      } catch (error) {
        req.flash("error", `Nao foi possivel gerar o PIX automatico: ${error.message}`);
        return res.redirect("/app/carteira");
      }
    }

    data.payments.push(payment);
    audit(data, user.id, "wallet.deposit_created", "payments", null, { id: payment.id, amount }, req);
    store.write(data);
    return res.redirect(`/app/pagamentos/${payment.id}`);
  });

  app.post("/app/carteira/saques", requireAuth, async (req, res) => {
    const data = store.read();
    normalizeData(data);
    const user = getCurrentUser(data, req);
    const amount = Number(req.body.amount);
    const minimum = Number(data.settings.withdrawalMinimum || 20);
    if (!Number.isFinite(amount) || amount < minimum) {
      req.flash("error", `O saque minimo e ${res.locals.formatMoney(minimum)}.`);
      return res.redirect("/app/carteira");
    }
    if (amount > Number(user.walletBalance || 0)) {
      req.flash("error", "Saldo insuficiente para solicitar este saque.");
      return res.redirect("/app/carteira");
    }
    if (!isAsaasEnabled()) {
      req.flash("error", "Saque automatico indisponivel: ASAAS_API_KEY nao configurada.");
      return res.redirect("/app/carteira");
    }
    if (![11, 14].includes(String(user.billingCpfCnpj || "").length)) {
      req.flash("error", "Para sacar automaticamente, primeiro gere um deposito com CPF ou CNPJ do titular cadastrado.");
      return res.redirect("/app/carteira");
    }
    if (!user.emailVerifiedAt) {
      req.flash("error", "Valide o e-mail da conta antes de solicitar saque.");
      return res.redirect("/app/carteira");
    }

    const token = crypto.randomBytes(18).toString("hex");
    const code = generateRecoveryCode();
    req.session.pendingWithdrawal = {
      token,
      amount,
      codeHash: recoveryCodeHash(token, code),
      attempts: 0,
      expiresAt: new Date(Date.now() + 15 * 60 * 1000).toISOString()
    };

    if (isEmailEnabled()) {
      try {
        await sendWithdrawalCode(user, code, res.locals.formatMoney(amount));
        req.flash("success", `Enviamos um codigo de confirmacao para ${maskEmailAddress(user.email)}.`);
      } catch (error) {
        req.flash("error", `Nao foi possivel enviar o e-mail agora: ${error.message}`);
        req.flash("success", `Codigo de teste para confirmar saque de ${res.locals.formatMoney(amount)}: ${code}`);
      }
    } else {
      req.flash("success", "SMTP ainda nao configurado. Use o codigo de teste abaixo para confirmar o saque.");
      req.flash("success", `Codigo de teste para confirmar saque de ${res.locals.formatMoney(amount)}: ${code}`);
    }

    return res.redirect("/app/carteira/saques/confirmar");
  });

  app.get("/app/carteira/saques/confirmar", requireAuth, (req, res) => {
    const pendingWithdrawal = req.session.pendingWithdrawal;
    if (!pendingWithdrawal || new Date(pendingWithdrawal.expiresAt) < new Date()) {
      delete req.session.pendingWithdrawal;
      req.flash("error", "Codigo de saque expirado. Solicite o saque novamente.");
      return res.redirect("/app/carteira");
    }
    const data = store.read();
    normalizeData(data);
    const user = getCurrentUser(data, req);
    return res.render("app/withdrawal-confirm", {
      title: "Confirmar saque",
      user,
      amount: Number(pendingWithdrawal.amount || 0),
      attemptsLeft: Math.max(0, 5 - Number(pendingWithdrawal.attempts || 0))
    });
  });

  app.post("/app/carteira/saques/confirmar", requireAuth, async (req, res) => {
    const pendingWithdrawal = req.session.pendingWithdrawal;
    const code = onlyDigits(req.body.code).slice(0, 6);
    if (!pendingWithdrawal || new Date(pendingWithdrawal.expiresAt) < new Date()) {
      delete req.session.pendingWithdrawal;
      req.flash("error", "Codigo de saque expirado. Solicite o saque novamente.");
      return res.redirect("/app/carteira");
    }

    pendingWithdrawal.attempts = Number(pendingWithdrawal.attempts || 0);
    if (pendingWithdrawal.attempts >= 5) {
      delete req.session.pendingWithdrawal;
      req.flash("error", "Muitas tentativas. Solicite o saque novamente.");
      return res.redirect("/app/carteira");
    }

    if (code.length !== 6 || pendingWithdrawal.codeHash !== recoveryCodeHash(pendingWithdrawal.token, code)) {
      pendingWithdrawal.attempts += 1;
      req.flash("error", "Codigo de saque invalido.");
      return res.redirect("/app/carteira/saques/confirmar");
    }

    const data = store.read();
    normalizeData(data);
    const user = getCurrentUser(data, req);
    const amount = Number(pendingWithdrawal.amount);
    const minimum = Number(data.settings.withdrawalMinimum || 20);
    if (!Number.isFinite(amount) || amount < minimum) {
      delete req.session.pendingWithdrawal;
      req.flash("error", `O saque minimo e ${res.locals.formatMoney(minimum)}.`);
      return res.redirect("/app/carteira");
    }
    if (amount > Number(user.walletBalance || 0)) {
      delete req.session.pendingWithdrawal;
      req.flash("error", "Saldo insuficiente para concluir este saque.");
      return res.redirect("/app/carteira");
    }
    if (!user.emailVerifiedAt) {
      delete req.session.pendingWithdrawal;
      req.flash("error", "Valide o e-mail da conta antes de solicitar saque.");
      return res.redirect("/app/carteira");
    }
    if (!isAsaasEnabled()) {
      delete req.session.pendingWithdrawal;
      req.flash("error", "Saque automatico indisponivel: ASAAS_API_KEY nao configurada.");
      return res.redirect("/app/carteira");
    }
    if (![11, 14].includes(String(user.billingCpfCnpj || "").length)) {
      delete req.session.pendingWithdrawal;
      req.flash("error", "Para sacar automaticamente, primeiro gere um deposito com CPF ou CNPJ do titular cadastrado.");
      return res.redirect("/app/carteira");
    }

    const beforeBalance = Number(user.walletBalance || 0);
    user.walletBalance = beforeBalance - amount;
    const payment = {
      id: store.nextId(data, "payments"),
      type: "withdrawal",
      userId: user.id,
      poolId: null,
      participationId: null,
      amount,
      status: "awaiting",
      method: "PIX",
      pixCode: null,
      pixEncodedImage: null,
      pixExpirationDate: null,
      payoutPixKey: user.billingCpfCnpj,
      payoutPixKeyType: String(user.billingCpfCnpj).length === 14 ? "CNPJ" : "CPF",
      provider: "asaas",
      providerPaymentId: null,
      providerTransferId: null,
      providerStatus: null,
      externalReference: null,
      invoiceUrl: null,
      transactionId: null,
      createdAt: todayIso(),
      updatedAt: todayIso(),
      confirmedAt: null,
      debitedAt: todayIso(),
      refundedAt: null
    };
    payment.externalReference = `wallet-withdrawal-${payment.id}`;
    data.payments.push(payment);
    audit(
      data,
      user.id,
      "wallet.withdrawal_requested",
      "payments",
      { id: user.id, walletBalance: beforeBalance },
      { id: payment.id, amount, walletBalance: user.walletBalance },
      req
    );
    store.write(data);

    let finalStatus = payment.status;
    try {
      const transfer = await createPixWithdrawalTransfer(data, user, payment);
      const latest = store.read();
      normalizeData(latest);
      const latestPayment = latest.payments.find((item) => item.id === payment.id);
      if (latestPayment) {
        latestPayment.provider = "asaas";
        latestPayment.providerTransferId = transfer.id;
        latestPayment.providerStatus = transfer.status;
        latestPayment.transactionId = transfer.id;
        latestPayment.transferReceiptUrl = transfer.transactionReceiptUrl || latestPayment.transferReceiptUrl || null;
        latestPayment.endToEndIdentifier = transfer.endToEndIdentifier || latestPayment.endToEndIdentifier || null;
        latestPayment.updatedAt = todayIso();
        if (["DONE"].includes(transfer.status)) {
          latestPayment.status = "paid";
          latestPayment.confirmedAt = todayIso();
        }
        finalStatus = latestPayment.status;
        store.write(latest);
      }
    } catch (error) {
      const latest = store.read();
      normalizeData(latest);
      const latestUser = latest.users.find((item) => item.id === user.id);
      const latestPayment = latest.payments.find((item) => item.id === payment.id);
      if (latestUser && latestPayment && !latestPayment.refundedAt) {
        latestUser.walletBalance = Number(latestUser.walletBalance || 0) + Number(latestPayment.amount || 0);
        latestPayment.status = "canceled";
        latestPayment.providerStatus = "FAILED_TO_CREATE";
        latestPayment.refundedAt = todayIso();
        latestPayment.updatedAt = todayIso();
        audit(latest, user.id, "wallet.withdrawal_canceled", "payments", { id: payment.id }, { id: payment.id, error: error.message }, req);
        store.write(latest);
      }
      delete req.session.pendingWithdrawal;
      req.flash("error", `Nao foi possivel enviar o saque pelo Asaas: ${error.message}`);
      return res.redirect("/app/carteira");
    }

    delete req.session.pendingWithdrawal;
    req.flash("success", finalStatus === "paid" ? "Saque enviado automaticamente para o CPF/CNPJ cadastrado." : "Saque enviado ao Asaas. O valor ficou reservado ate a conclusao da transferencia.");
    return res.redirect("/app/carteira");
  });

  app.get("/app/perfil", requireAuth, (req, res) => {
    const data = store.read();
    normalizeData(data);
    res.render("app/profile", { title: "Meu perfil", user: getCurrentUser(data, req) });
  });

  app.post("/app/lgpd/exclusao", requireAuth, (req, res) => {
    const data = store.read();
    normalizeData(data);
    const user = getCurrentUser(data, req);
    audit(data, user.id, "lgpd.deletion_requested", "users", null, { userId: user.id }, req);
    store.write(data);
    req.flash("success", "Solicitacao registrada. O administrador devera avaliar a retencao legal dos dados.");
    res.redirect("/app/perfil");
  });

  app.get("/app/boloes/:id/auditoria", requireAuth, (req, res) => {
    const data = store.read();
    normalizeData(data);
    const pool = data.pools.find((item) => item.id === Number(req.params.id));
    if (!pool || !isPoolAuditAvailable(pool)) {
      req.flash("error", "A auditoria fica disponivel quando o bolao estiver fechado.");
      return res.redirect("/app/boloes");
    }
    const snapshot = ensurePoolAuditSnapshot(data, pool, req.session.userId, req);
    store.write(data);
    res.render("app/audit", {
      title: "Auditoria do bolao",
      pool,
      snapshot,
      matches: snapshot.payload.matches,
      participants: snapshot.payload.participants
    });
  });

  app.get("/app/boloes/:id/auditoria/download", requireAuth, (req, res) => {
    const data = store.read();
    normalizeData(data);
    const pool = data.pools.find((item) => item.id === Number(req.params.id));
    if (!pool || !isPoolAuditAvailable(pool)) {
      req.flash("error", "A auditoria fica disponivel quando o bolao estiver fechado.");
      return res.redirect("/app/boloes");
    }
    const snapshot = ensurePoolAuditSnapshot(data, pool, req.session.userId, req);
    store.write(data);
    const fileName = `auditoria-bolao-${pool.id}-${snapshot.hash.slice(0, 10)}.json`;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${fileName}"`);
    return res.send(JSON.stringify(snapshot, null, 2));
  });

  app.post("/app/boloes/:id/participar", requireAuth, (req, res) => {
    const poolId = Number(req.params.id);
    const data = store.read();
    normalizeData(data);
    const user = getCurrentUser(data, req);
    const pool = data.pools.find((item) => item.id === poolId && item.status === "open");
    if (!pool) {
      req.flash("error", "Bolao indisponivel.");
      return res.redirect("/app/conta");
    }
    const existing = data.participations.find((item) => item.userId === user.id && item.poolId === poolId);
    const entryValue = Number(pool.entryValue || 0);
    if (existing) {
      if (existing.status === "paid") return res.redirect(`/app/boloes/${poolId}/palpites`);
      if (Number(user.walletBalance || 0) < entryValue) {
        req.flash("error", `Saldo insuficiente para participar. Deposite ${res.locals.formatMoney(entryValue)} na carteira.`);
        return res.redirect("/app/carteira");
      }
      const beforeBalance = Number(user.walletBalance || 0);
      user.walletBalance = beforeBalance - entryValue;
      existing.status = "paid";
      let payment = data.payments.find((item) => item.participationId === existing.id);
      if (payment) {
        payment.type = "pool_entry";
        payment.amount = entryValue;
        payment.status = "paid";
        payment.method = "WALLET";
        payment.pixCode = null;
        payment.transactionId = `WALLET-${user.id}-${poolId}-${Date.now()}`;
        payment.confirmedAt = todayIso();
      } else {
        payment = {
          id: store.nextId(data, "payments"),
          type: "pool_entry",
          userId: user.id,
          poolId,
          participationId: existing.id,
          amount: entryValue,
          status: "paid",
          method: "WALLET",
          pixCode: null,
          transactionId: `WALLET-${user.id}-${poolId}-${Date.now()}`,
          createdAt: todayIso(),
          confirmedAt: todayIso()
        };
        data.payments.push(payment);
      }
      audit(data, user.id, "wallet.pending_entry_debited", "payments", { walletBalance: beforeBalance }, { id: payment.id, poolId, walletBalance: user.walletBalance }, req);
      store.write(data);
      req.flash("success", "Entrada debitada da carteira. Seus palpites estao liberados.");
      return res.redirect(`/app/boloes/${poolId}/palpites`);
    }
    if (Number(user.walletBalance || 0) < entryValue) {
      req.flash("error", `Saldo insuficiente para participar. Deposite ${res.locals.formatMoney(entryValue)} na carteira.`);
      return res.redirect("/app/carteira");
    }
    const participation = {
      id: store.nextId(data, "participations"),
      userId: user.id,
      poolId,
      status: "paid",
      createdAt: todayIso()
    };
    const beforeBalance = Number(user.walletBalance || 0);
    user.walletBalance = beforeBalance - entryValue;
    const payment = {
      id: store.nextId(data, "payments"),
      type: "pool_entry",
      userId: user.id,
      poolId,
      participationId: participation.id,
      amount: entryValue,
      status: "paid",
      method: "WALLET",
      pixCode: null,
      transactionId: `WALLET-${user.id}-${poolId}-${Date.now()}`,
      createdAt: todayIso(),
      confirmedAt: todayIso()
    };
    data.participations.push(participation);
    data.payments.push(payment);
    audit(data, user.id, "wallet.pool_entry_debited", "payments", { walletBalance: beforeBalance }, { id: payment.id, poolId, walletBalance: user.walletBalance }, req);
    store.write(data);
    req.flash("success", "Entrada debitada da carteira. Seus palpites estao liberados.");
    return res.redirect(`/app/boloes/${poolId}/palpites`);
  });

  app.get("/app/pagamentos/:id", requireAuth, (req, res) => {
    const data = store.read();
    normalizeData(data);
    const user = getCurrentUser(data, req);
    const payment = data.payments.find((item) => item.id === Number(req.params.id) && item.userId === user.id);
    if (!payment) return res.redirect("/app/conta");
    const pool = data.pools.find((item) => item.id === payment.poolId);
    res.render("app/payment", { title: "Pagamento PIX", payment, pool });
  });

  app.post("/app/pagamentos/:id/sincronizar", requireAuth, async (req, res) => {
    const data = store.read();
    normalizeData(data);
    const user = getCurrentUser(data, req);
    const payment = data.payments.find((item) => item.id === Number(req.params.id) && item.userId === user.id);
    const wantsJson = req.get("accept")?.includes("application/json");
    if (!payment) {
      if (wantsJson) return res.status(404).json({ ok: false, message: "Pagamento nao encontrado." });
      return res.redirect("/app/conta");
    }
    if (payment.provider !== "asaas" || !payment.providerPaymentId) {
      if (wantsJson) {
        return res.status(400).json({ ok: false, message: "Este pagamento nao possui cobranca Asaas para sincronizar." });
      }
      req.flash("error", "Este pagamento nao possui cobranca Asaas para sincronizar.");
      return res.redirect(`/app/pagamentos/${payment.id}`);
    }

    try {
      const asaasPayment = await getAsaasPayment(payment.providerPaymentId);
      applyAsaasPaymentStatus(data, payment, asaasPayment, "MANUAL_SYNC", req);
      store.write(data);
      const message = payment.status === "paid"
        ? "Pagamento confirmado. O dinheiro foi depositado na sua carteira."
        : "Aguardando confirmacao do Asaas.";
      if (wantsJson) {
        return res.json({
          ok: true,
          status: payment.status,
          statusLabel: labelForStatus(payment.status),
          providerStatus: payment.providerStatus,
          credited: Boolean(payment.creditedAt),
          walletBalance: Number(user.walletBalance || 0),
          message
        });
      }
      req.flash("success", payment.status === "paid" ? "Pagamento confirmado e carteira atualizada." : "Status consultado no Asaas. O pagamento ainda nao consta como recebido.");
    } catch (error) {
      if (wantsJson) {
        return res.status(502).json({ ok: false, message: `Nao foi possivel consultar o Asaas: ${error.message}` });
      }
      req.flash("error", `Nao foi possivel consultar o Asaas: ${error.message}`);
    }
    return res.redirect(`/app/pagamentos/${payment.id}`);
  });

  app.get("/app/boloes/:id/palpites", requireAuth, (req, res) => {
    const data = store.read();
    normalizeData(data);
    const user = getCurrentUser(data, req);
    const poolId = Number(req.params.id);
    const pool = data.pools.find((item) => item.id === poolId);
    const canAccessPool = requirePaidParticipation(data, user.id, poolId) || ["admin", "super_admin"].includes(user.role);
    if (!pool || !canAccessPool) {
      req.flash("error", "Participe do bolao usando o saldo da carteira para liberar os palpites.");
      return res.redirect("/app/conta");
    }
    const matches = data.matches.filter((match) => match.poolId === poolId);
    const guesses = data.guesses.filter((guess) => guess.poolId === poolId && guess.userId === user.id);
    const financials = poolFinancials(data, pool);
    const ranking = rankingForPool(data, poolId);
    res.render("app/guesses", {
      title: "Meus palpites",
      pool,
      matches,
      guesses,
      financials,
      ranking,
      locked: new Date(pool.deadlineAt) <= new Date()
    });
  });

  app.post("/app/boloes/:id/palpites", requireAuth, (req, res) => {
    const poolId = Number(req.params.id);
    const data = store.read();
    normalizeData(data);
    const user = getCurrentUser(data, req);
    const pool = data.pools.find((item) => item.id === poolId);
    const canAccessPool = requirePaidParticipation(data, user.id, poolId) || ["admin", "super_admin"].includes(user.role);
    if (!pool || !canAccessPool) {
      req.flash("error", "Participe do bolao usando o saldo da carteira para liberar os palpites.");
      return res.redirect("/app/conta");
    }
    if (new Date(pool.deadlineAt) <= new Date()) {
      req.flash("error", "O prazo de edicao dos palpites terminou.");
      return res.redirect(`/app/boloes/${poolId}/palpites`);
    }
    const matches = data.matches.filter((match) => match.poolId === poolId);
    matches.forEach((match) => {
      const rawHomeScore = String(req.body[`home_${match.id}`] ?? "").trim();
      const rawAwayScore = String(req.body[`away_${match.id}`] ?? "").trim();
      const existing = data.guesses.find(
        (guess) => guess.poolId === poolId && guess.matchId === match.id && guess.userId === user.id
      );
      if (!rawHomeScore && !rawAwayScore) {
        if (existing) {
          existing.homeScore = null;
          existing.awayScore = null;
          existing.points = 0;
          existing.category = "pending";
          existing.updatedAt = todayIso();
          existing.ip = req.ip;
        }
        return;
      }
      if (!rawHomeScore || !rawAwayScore) return;
      const homeScore = Number(rawHomeScore);
      const awayScore = Number(rawAwayScore);
      if (!Number.isInteger(homeScore) || !Number.isInteger(awayScore) || homeScore < 0 || awayScore < 0) return;
      const before = existing ? { homeScore: existing.homeScore, awayScore: existing.awayScore } : null;
      if (existing) {
        existing.homeScore = homeScore;
        existing.awayScore = awayScore;
        existing.updatedAt = todayIso();
        existing.ip = req.ip;
      } else {
        data.guesses.push({
          id: store.nextId(data, "guesses"),
          userId: user.id,
          poolId,
          matchId: match.id,
          homeScore,
          awayScore,
          points: 0,
          category: "pending",
          ip: req.ip,
          createdAt: todayIso(),
          updatedAt: todayIso()
        });
      }
      audit(data, user.id, "guess.saved", "guesses", before, { matchId: match.id, homeScore, awayScore }, req);
    });
    recalculatePool(data, poolId);
    store.write(data);
    req.flash("success", "Palpites salvos.");
    return res.redirect(`/app/boloes/${poolId}/palpites`);
  });

  app.get("/app/boloes/:id/ranking", requireAuth, (req, res) => {
    const data = store.read();
    normalizeData(data);
    const pool = data.pools.find((item) => item.id === Number(req.params.id));
    if (!pool) return res.redirect("/app/conta");
    res.render("app/ranking", {
      title: "Ranking",
      pool,
      rows: rankingForPool(data, pool.id),
      financials: poolFinancials(data, pool)
    });
  });

  app.get("/admin", requireAuth, requireAdmin, (req, res) => {
    const data = store.read();
    normalizeData(data);
    res.render("admin/dashboard", {
      title: "Painel",
      usersCount: data.users.length,
      pools: data.pools.map((pool) => ({ ...pool, financials: poolFinancials(data, pool) })),
      pendingPayments: data.payments.filter((payment) => ["deposit", "withdrawal"].includes(payment.type) && payment.status === "awaiting").length,
      logs: data.auditLogs.slice(-8).reverse()
    });
  });

  app.get("/admin/sofascore-robo", requireAuth, requireAdmin, (req, res) => {
    const data = store.read();
    normalizeData(data);
    const snapshots = (data.sofascoreSnapshots || [])
      .slice()
      .sort((a, b) => new Date(b.finishedAt || b.createdAt).getTime() - new Date(a.finishedAt || a.createdAt).getTime());
    res.render("admin/sofascore-browser", {
      title: "Robo SofaScore",
      lastResult: data.settings.sofascoreBrowserLastResult,
      latestSnapshot: snapshots[0] || latestSofaScoreSnapshot(data),
      snapshots: snapshots.slice(0, 10),
      defaultUrl: process.env.SOFASCORE_BROWSER_URL || "https://www.sofascore.com/pt/futebol/"
    });
  });

  app.post("/admin/sofascore-robo/testar", requireAuth, requireAdmin, async (req, res) => {
    const data = store.read();
    normalizeData(data);
    const user = getCurrentUser(data, req);
    try {
      const { result } = await updateSofaScoreCache(store, {
        url: req.body.url,
        userId: user.id,
        req,
        source: "manual"
      });
      req.flash(result.ok ? "success" : "error", result.ok ? "Cache do monitor atualizado. Confira os jogos salvos abaixo." : `Monitor falhou: ${result.error}`);
    } catch (error) {
      req.flash("error", error.message);
    }
    return res.redirect("/admin/sofascore-robo");
  });

  app.get("/admin/boloes", requireAuth, requireAdmin, (req, res) => {
    const data = store.read();
    normalizeData(data);
    res.render("admin/pools", {
      title: "Boloes",
      pools: data.pools.map((pool) => ({ ...pool, financials: poolFinancials(data, pool) }))
    });
  });

  app.post("/admin/boloes", requireAuth, requireAdmin, (req, res) => {
    const data = store.read();
    normalizeData(data);
    const user = getCurrentUser(data, req);
    const entryValue = Number(req.body.entryValue);
    if (!req.body.name || !req.body.deadlineAt || !Number.isFinite(entryValue) || entryValue <= 0) {
      req.flash("error", "Informe nome, prazo e o valor da entrada definido pelo administrador.");
      return res.redirect("/admin/boloes");
    }
    const pool = {
      id: store.nextId(data, "pools"),
      name: String(req.body.name).trim(),
      round: String(req.body.round || "").trim(),
      startsAt: req.body.startsAt || todayIso(),
      deadlineAt: new Date(req.body.deadlineAt).toISOString(),
      entryValue,
      adminFeePercent: Number(req.body.adminFeePercent || data.settings.entryAdminFeePercent),
      status: req.body.status || "draft",
      prizeModel: req.body.prizeModel || "winner_take_all",
      createdAt: todayIso()
    };
    data.pools.push(pool);
    if (pool.status === "closed") ensurePoolAuditSnapshot(data, pool, user.id, req);
    audit(data, user.id, "pool.created", "pools", null, pool, req);
    store.write(data);
    req.flash("success", "Bolao criado.");
    res.redirect("/admin/boloes");
  });

  app.post("/admin/boloes/:id/status", requireAuth, requireAdmin, (req, res) => {
    const data = store.read();
    normalizeData(data);
    const user = getCurrentUser(data, req);
    const pool = data.pools.find((item) => item.id === Number(req.params.id));
    const allowed = ["draft", "open", "closed", "finished"];
    if (!pool || !allowed.includes(req.body.status)) {
      req.flash("error", "Status de bolao invalido.");
      return res.redirect("/admin/boloes");
    }
    const before = { status: pool.status, auditSnapshot: pool.auditSnapshot?.hash || null };
    pool.status = req.body.status;
    pool.updatedAt = todayIso();
    if (pool.status === "closed" || pool.status === "finished") {
      ensurePoolAuditSnapshot(data, pool, user.id, req);
    } else {
      delete pool.auditSnapshot;
    }
    audit(data, user.id, "pool.status_changed", "pools", before, {
      id: pool.id,
      status: pool.status,
      auditSnapshot: pool.auditSnapshot?.hash || null
    }, req);
    store.write(data);
    req.flash("success", pool.auditSnapshot ? "Status atualizado e auditoria preservada." : "Status atualizado.");
    return res.redirect("/admin/boloes");
  });

  app.post("/admin/boloes/:id/excluir", requireAuth, requireAdmin, (req, res) => {
    const data = store.read();
    normalizeData(data);
    const admin = getCurrentUser(data, req);
    const poolId = Number(req.params.id);
    const pool = data.pools.find((item) => item.id === poolId);
    if (!pool) {
      req.flash("error", "Bolao nao encontrado.");
      return res.redirect("/admin/boloes");
    }

    const paidParticipations = data.participations.filter(
      (participation) => participation.poolId === poolId && participation.status === "paid"
    );

    if (!paidParticipations.length) {
      const before = { ...pool };
      const matchIds = new Set(data.matches.filter((match) => match.poolId === poolId).map((match) => match.id));
      data.pools = data.pools.filter((item) => item.id !== poolId);
      data.matches = data.matches.filter((match) => match.poolId !== poolId);
      data.guesses = data.guesses.filter((guess) => guess.poolId !== poolId && !matchIds.has(guess.matchId));
      data.participations = data.participations.filter((participation) => participation.poolId !== poolId);
      data.payments = data.payments.filter((payment) => payment.poolId !== poolId);
      audit(data, admin.id, "pool.deleted", "pools", before, null, req);
      store.write(data);
      req.flash("success", "Bolao excluido.");
      return res.redirect("/admin/boloes");
    }

    if (pool.status === "canceled") {
      req.flash("error", "Este bolao ja esta cancelado.");
      return res.redirect("/admin/boloes");
    }

    const beforePool = { status: pool.status, canceledAt: pool.canceledAt };
    pool.status = "canceled";
    pool.canceledAt = todayIso();

    let refundedCount = 0;
    let refundedAmount = 0;
    paidParticipations.forEach((participation) => {
      const user = data.users.find((item) => item.id === participation.userId);
      const entryPayment = data.payments.find(
        (payment) => payment.type === "pool_entry" && payment.participationId === participation.id
      );
      const amount = Number(entryPayment?.amount || pool.entryValue || 0);
      if (!user || amount <= 0) return;

      const beforeBalance = Number(user.walletBalance || 0);
      user.walletBalance = beforeBalance + amount;
      participation.status = "refunded";
      participation.refundedAt = todayIso();

      if (entryPayment) {
        entryPayment.status = "refunded";
        entryPayment.refundedAt = todayIso();
        entryPayment.updatedAt = todayIso();
      }

      const refundPayment = {
        id: store.nextId(data, "payments"),
        type: "pool_refund",
        method: "WALLET",
        userId: user.id,
        poolId,
        participationId: participation.id,
        amount,
        status: "paid",
        qrCode: null,
        pixPayload: null,
        transactionId: `REFUND-${user.id}-${poolId}-${Date.now()}`,
        confirmedAt: todayIso(),
        creditedAt: todayIso(),
        createdAt: todayIso()
      };
      data.payments.push(refundPayment);
      refundedCount += 1;
      refundedAmount += amount;
      audit(
        data,
        admin.id,
        "wallet.pool_entry_refunded",
        "users",
        { id: user.id, walletBalance: beforeBalance },
        { id: user.id, walletBalance: user.walletBalance, poolId, paymentId: refundPayment.id },
        req
      );
    });

    audit(
      data,
      admin.id,
      "pool.canceled",
      "pools",
      beforePool,
      { status: pool.status, canceledAt: pool.canceledAt, refundedCount, refundedAmount },
      req
    );
    store.write(data);
    req.flash("success", `Bolao cancelado. ${refundedCount} participacao(oes) devolvida(s) para a carteira.`);
    return res.redirect("/admin/boloes");
  });

  app.get("/admin/jogos", requireAuth, requireAdmin, (req, res) => {
    const data = store.read();
    normalizeData(data);
    res.render("admin/matches", {
      title: "Jogos",
      pools: data.pools,
      matches: data.matches.map((match) => ({
        ...match,
        poolName: data.pools.find((pool) => pool.id === match.poolId)?.name || "-"
      })),
      championships,
      teams
    });
  });

  app.post("/admin/jogos", requireAuth, requireAdmin, (req, res) => {
    const data = store.read();
    normalizeData(data);
    const user = getCurrentUser(data, req);
    const poolId = Number(req.body.poolId);
    const homeTeam = String(req.body.homeTeam || "").trim();
    const awayTeam = String(req.body.awayTeam || "").trim();
    const homeTeamMeta = teams.find((team) => team.name === homeTeam && team.championship === req.body.championship);
    const awayTeamMeta = teams.find((team) => team.name === awayTeam && team.championship === req.body.championship);
    if (!data.pools.some((pool) => pool.id === poolId) || !championships.includes(req.body.championship)) {
      req.flash("error", "Bolao ou campeonato invalido.");
      return res.redirect("/admin/jogos");
    }
    if (
      !isKnownTeam(homeTeam) ||
      !isKnownTeam(awayTeam) ||
      homeTeam === awayTeam ||
      homeTeamMeta?.championship !== req.body.championship ||
      awayTeamMeta?.championship !== req.body.championship
    ) {
      req.flash("error", "Selecione mandante e visitante validos e diferentes.");
      return res.redirect("/admin/jogos");
    }
    if (!isWeekend(req.body.matchDate)) {
      req.flash("error", "O MVP aceita apenas jogos de sabado ou domingo.");
      return res.redirect("/admin/jogos");
    }
    const match = {
      id: store.nextId(data, "matches"),
      poolId,
      championship: req.body.championship,
      round: String(req.body.round || "").trim(),
      homeTeam,
      awayTeam,
      matchDate: req.body.matchDate,
      matchTime: req.body.matchTime,
      venue: String(req.body.venue || "").trim(),
      homeScore: null,
      awayScore: null,
      status: "scheduled",
      createdAt: todayIso()
    };
    if (!match.homeTeam || !match.awayTeam || !match.matchDate || !match.matchTime) {
      req.flash("error", "Preencha mandante, visitante, data e horario.");
      return res.redirect("/admin/jogos");
    }
    data.matches.push(match);
    audit(data, user.id, "match.created", "matches", null, match, req);
    store.write(data);
    req.flash("success", "Jogo cadastrado.");
    res.redirect("/admin/jogos");
  });

  app.post("/admin/jogos/:id/excluir", requireAuth, requireAdmin, (req, res) => {
    const data = store.read();
    normalizeData(data);
    const user = getCurrentUser(data, req);
    const matchId = Number(req.params.id);
    const match = data.matches.find((item) => item.id === matchId);
    if (!match) {
      req.flash("error", "Jogo nao encontrado.");
      return res.redirect("/admin/jogos");
    }
    const before = { ...match };
    data.matches = data.matches.filter((item) => item.id !== matchId);
    data.guesses = data.guesses.filter((guess) => guess.matchId !== matchId);
    recalculatePool(data, match.poolId);
    audit(data, user.id, "match.deleted", "matches", before, null, req);
    store.write(data);
    req.flash("success", "Jogo excluido.");
    return res.redirect("/admin/jogos");
  });

  app.get("/admin/pagamentos", requireAuth, requireAdmin, (req, res) => {
    const data = store.read();
    normalizeData(data);
    const payments = data.payments.map((payment) => ({
      ...payment,
      user: data.users.find((user) => user.id === payment.userId),
      pool: data.pools.find((pool) => pool.id === payment.poolId)
    }));
    res.render("admin/payments", { title: "Pagamentos", payments, paymentStatuses });
  });

  app.post("/admin/pagamentos/:id/status", requireAuth, requireAdmin, (req, res) => {
    const data = store.read();
    normalizeData(data);
    const admin = getCurrentUser(data, req);
    const payment = data.payments.find((item) => item.id === Number(req.params.id));
    if (!payment || !paymentStatuses.includes(req.body.status)) {
      req.flash("error", "Pagamento invalido.");
      return res.redirect("/admin/pagamentos");
    }
    const before = { status: payment.status, creditedAt: payment.creditedAt };
    const user = data.users.find((item) => item.id === payment.userId);
    payment.status = req.body.status;
    payment.transactionId = req.body.transactionId || payment.transactionId;
    payment.confirmedAt = payment.status === "paid" ? todayIso() : payment.confirmedAt;
    if (payment.type === "deposit" && user) {
      if (before.status !== "paid" && payment.status === "paid") {
        const beforeBalance = Number(user.walletBalance || 0);
        user.walletBalance = beforeBalance + Number(payment.amount || 0);
        payment.creditedAt = todayIso();
        audit(data, admin.id, "wallet.deposit_credited", "users", { id: user.id, walletBalance: beforeBalance }, { id: user.id, walletBalance: user.walletBalance, paymentId: payment.id }, req);
      } else if (before.status === "paid" && payment.status !== "paid" && payment.creditedAt) {
        const amount = Number(payment.amount || 0);
        if (Number(user.walletBalance || 0) < amount) {
          req.flash("error", "Nao e possivel estornar: saldo atual do usuario e menor que o deposito.");
          return res.redirect("/admin/pagamentos");
        }
        const beforeBalance = Number(user.walletBalance || 0);
        user.walletBalance = beforeBalance - amount;
        payment.creditedAt = null;
        audit(data, admin.id, "wallet.deposit_reversed", "users", { id: user.id, walletBalance: beforeBalance }, { id: user.id, walletBalance: user.walletBalance, paymentId: payment.id }, req);
      }
    }
    const participation = data.participations.find((item) => item.id === payment.participationId);
    if (participation) {
      participation.status = payment.status === "paid" ? "paid" : payment.status === "awaiting" ? "awaiting_payment" : payment.status;
    }
    audit(data, admin.id, "payment.status_changed", "payments", before, payment, req);
    store.write(data);
    req.flash("success", "Status atualizado.");
    res.redirect("/admin/pagamentos");
  });

  app.post("/admin/pagamentos/:id/sincronizar-asaas", requireAuth, requireAdmin, async (req, res) => {
    const data = store.read();
    normalizeData(data);
    const payment = data.payments.find((item) => item.id === Number(req.params.id));
    if (!payment || payment.provider !== "asaas" || !payment.providerPaymentId) {
      req.flash("error", "Pagamento Asaas invalido para sincronizacao.");
      return res.redirect("/admin/pagamentos");
    }

    try {
      const asaasPayment = await getAsaasPayment(payment.providerPaymentId);
      applyAsaasPaymentStatus(data, payment, asaasPayment, "ADMIN_SYNC", req);
      store.write(data);
      req.flash(
        "success",
        payment.status === "paid"
          ? "Pagamento confirmado no Asaas e carteira atualizada."
          : "Status consultado no Asaas. O pagamento ainda nao consta como recebido."
      );
    } catch (error) {
      req.flash("error", `Nao foi possivel consultar o Asaas: ${error.message}`);
    }
    return res.redirect("/admin/pagamentos");
  });

  app.post("/admin/pagamentos/:id/saque", requireAuth, requireAdmin, (req, res) => {
    const data = store.read();
    normalizeData(data);
    const admin = getCurrentUser(data, req);
    const payment = data.payments.find((item) => item.id === Number(req.params.id));
    const user = payment ? data.users.find((item) => item.id === payment.userId) : null;
    const action = req.body.action;
    if (!payment || payment.type !== "withdrawal" || !user) {
      req.flash("error", "Saque invalido.");
      return res.redirect("/admin/pagamentos");
    }
    if (payment.status === "paid") {
      req.flash("error", "Este saque ja foi marcado como pago.");
      return res.redirect("/admin/pagamentos");
    }
    if (payment.status === "canceled" || payment.status === "refunded") {
      req.flash("error", "Este saque ja foi cancelado.");
      return res.redirect("/admin/pagamentos");
    }

    const before = { status: payment.status, refundedAt: payment.refundedAt, transactionId: payment.transactionId };
    if (action === "paid") {
      payment.status = "paid";
      payment.transactionId = req.body.transactionId || payment.transactionId || `SAQUE-${payment.id}-${Date.now()}`;
      payment.confirmedAt = todayIso();
      payment.updatedAt = todayIso();
      audit(data, admin.id, "wallet.withdrawal_paid", "payments", before, payment, req);
      req.flash("success", "Saque marcado como pago.");
    } else if (action === "canceled") {
      const beforeBalance = Number(user.walletBalance || 0);
      user.walletBalance = beforeBalance + Number(payment.amount || 0);
      payment.status = "canceled";
      payment.refundedAt = todayIso();
      payment.updatedAt = todayIso();
      audit(
        data,
        admin.id,
        "wallet.withdrawal_canceled",
        "users",
        { id: user.id, walletBalance: beforeBalance, payment: before },
        { id: user.id, walletBalance: user.walletBalance, paymentId: payment.id },
        req
      );
      req.flash("success", "Saque cancelado e valor devolvido para a carteira.");
    } else {
      req.flash("error", "Acao de saque invalida.");
      return res.redirect("/admin/pagamentos");
    }

    audit(data, admin.id, "payment.status_changed", "payments", before, payment, req);
    store.write(data);
    return res.redirect("/admin/pagamentos");
  });

  app.get("/admin/resultados", requireAuth, requireAdmin, (req, res) => {
    const data = store.read();
    normalizeData(data);
    res.render("admin/results", {
      title: "Resultados",
      matches: data.matches.map((match) => ({
        ...match,
        poolName: data.pools.find((pool) => pool.id === match.poolId)?.name || "-"
      }))
    });
  });

  app.post("/admin/jogos/:id/resultado", requireAuth, requireAdmin, (req, res) => {
    const data = store.read();
    normalizeData(data);
    const admin = getCurrentUser(data, req);
    const match = data.matches.find((item) => item.id === Number(req.params.id));
    if (!match) return res.redirect("/admin/resultados");
    const homeScore = Number(req.body.homeScore);
    const awayScore = Number(req.body.awayScore);
    if (!Number.isInteger(homeScore) || !Number.isInteger(awayScore) || homeScore < 0 || awayScore < 0) {
      req.flash("error", "Placar invalido.");
      return res.redirect("/admin/resultados");
    }
    const before = { homeScore: match.homeScore, awayScore: match.awayScore, status: match.status };
    match.homeScore = homeScore;
    match.awayScore = awayScore;
    match.status = "finished";
    audit(data, admin.id, "match.result_entered", "matches", before, match, req);
    recalculatePool(data, match.poolId);
    store.write(data);
    req.flash("success", "Resultado salvo e pontuacao recalculada.");
    res.redirect("/admin/resultados");
  });

  app.get("/admin/ranking/:id", requireAuth, requireAdmin, (req, res) => {
    const data = store.read();
    normalizeData(data);
    const pool = data.pools.find((item) => item.id === Number(req.params.id));
    if (!pool) return res.redirect("/admin");
    res.render("app/ranking", {
      title: "Ranking",
      pool,
      rows: rankingForPool(data, pool.id),
      financials: poolFinancials(data, pool)
    });
  });

  app.get("/admin/usuarios", requireAuth, requireAdmin, (req, res) => {
    const data = store.read();
    normalizeData(data);
    res.render("admin/users", { title: "Usuarios", users: data.users });
  });

  app.post("/admin/usuarios/:id/status", requireAuth, requireAdmin, (req, res) => {
    const data = store.read();
    normalizeData(data);
    const admin = getCurrentUser(data, req);
    const user = data.users.find((item) => item.id === Number(req.params.id));
    if (!user || !["active", "blocked"].includes(req.body.status)) return res.redirect("/admin/usuarios");
    const before = { status: user.status };
    user.status = req.body.status;
    audit(data, admin.id, "user.status_changed", "users", before, { id: user.id, status: user.status }, req);
    store.write(data);
    req.flash("success", "Usuario atualizado.");
    res.redirect("/admin/usuarios");
  });

  app.get("/admin/logs", requireAuth, requireAdmin, (req, res) => {
    const data = store.read();
    normalizeData(data);
    res.render("admin/logs", {
      title: "Auditoria",
      logs: data.auditLogs
        .slice()
        .reverse()
        .map((log) => ({ ...log, actor: data.users.find((user) => user.id === log.actorId) }))
    });
  });

  return app;
}

module.exports = { router, startSofaScoreAutoMonitor, updateSofaScoreCache };
