const crypto = require("crypto");
const bcrypt = require("bcryptjs");
const express = require("express");

const { requireAuth, requireAdmin } = require("./middleware/auth");
const { createPixDepositCharge, getAsaasPayment, isAsaasEnabled } = require("./services/asaas");
const { audit } = require("./services/audit");
const { recalculatePool, rankingForPool } = require("./services/scoring");
const {
  hashCpf,
  isAdult,
  isValidCpf,
  isWeekend,
  maskCpf,
  onlyDigits,
  labelForStatus,
  strongPassword,
  todayIso
} = require("./utils");

const championships = ["Serie A", "Serie B", "Serie C", "Serie D"];
const paymentStatuses = ["awaiting", "paid", "canceled", "refunded", "expired"];
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
  Goias: ["#008c45", "#ffffff"],
  Coritiba: ["#007a3d", "#ffffff"],
  Novorizontino: ["#f6c13a", "#111111"],
  "Vila Nova": ["#d71920", "#ffffff"],
  Avai: ["#1f73d8", "#ffffff"],
  Chapecoense: ["#1b8f3a", "#ffffff"],
  CRB: ["#d71920", "#ffffff"],
  Amazonas: ["#f6c13a", "#111111"],
  Mirassol: ["#f6c13a", "#16803c"],
  "Ponte Preta": ["#111111", "#ffffff"],
  Operario: ["#111111", "#ffffff"],
  Ituano: ["#d71920", "#111111"],
  Brusque: ["#f6c13a", "#d71920"],
  "Sampaio Correa": ["#f6c13a", "#16803c"],
  Juventude: ["#16803c", "#ffffff"],
  Londrina: ["#7dd3fc", "#ffffff"],
  Guarani: ["#16803c", "#ffffff"],
  Tombense: ["#d71920", "#ffffff"]
};

function initialsForTeam(name) {
  return String(name || "FC")
    .split(/\s|-/)
    .filter(Boolean)
    .map((part) => part[0])
    .join("")
    .slice(0, 3)
    .toUpperCase();
}

function escapeSvg(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function getCurrentUser(data, req) {
  return data.users.find((user) => user.id === req.session.userId);
}

function normalizeData(data) {
  data.payments ||= [];
  data.participations ||= [];
  data.users.forEach((user) => {
    user.walletBalance = Number(user.walletBalance || 0);
  });
  data.payments.forEach((payment) => {
    payment.type ||= payment.poolId ? "pool_entry" : "deposit";
    payment.amount = Number(payment.amount || 0);
  });
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

function router(store) {
  const app = express.Router();

  app.get("/crest/:team.svg", (req, res) => {
    const team = decodeURIComponent(req.params.team || "");
    const [primary, secondary] = teamColors[team] || ["#24323a", "#f5f7f8"];
    const initials = escapeSvg(initialsForTeam(team));
    const label = escapeSvg(team);
    const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" role="img" aria-label="${label}">
  <defs>
    <linearGradient id="g" x1="0" x2="1" y1="0" y2="1">
      <stop stop-color="${primary}" offset="0"/>
      <stop stop-color="${secondary}" offset="1"/>
    </linearGradient>
    <filter id="s" x="-20%" y="-20%" width="140%" height="140%">
      <feDropShadow dx="0" dy="2" stdDeviation="2" flood-color="#000" flood-opacity=".35"/>
    </filter>
  </defs>
  <path filter="url(#s)" d="M32 4 54 12v17c0 15-9 25-22 31C19 54 10 44 10 29V12L32 4Z" fill="url(#g)" stroke="#e8eef0" stroke-width="3"/>
  <path d="M17 15h30v8H17z" fill="#ffffff" opacity=".28"/>
  <path d="M32 8v49" stroke="#ffffff" stroke-width="4" opacity=".38"/>
  <circle cx="32" cy="34" r="14" fill="#000000" opacity=".22"/>
  <circle cx="32" cy="34" r="14" fill="none" stroke="#ffffff" stroke-width="2" opacity=".45"/>
  <text x="32" y="39" text-anchor="middle" font-family="Arial, sans-serif" font-size="15" font-weight="900" fill="#fff">${initials}</text>
</svg>`;
    res.type("image/svg+xml").set("Cache-Control", "public, max-age=86400").send(svg);
  });

  app.get("/", (req, res) => {
    const data = store.read();
    normalizeData(data);
    const openPools = data.pools
      .filter((pool) => pool.status === "open")
      .map((pool) => ({ ...pool, financials: poolFinancials(data, pool) }));
    res.render("home", { title: data.settings.appName, openPools });
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

    const errors = [];
    if (!name || !normalizedEmail || !phone || !birthDate) errors.push("Preencha todos os dados obrigatorios.");
    if (!isValidCpf(normalizedCpf)) errors.push("CPF invalido.");
    if (!isAdult(birthDate) || adultConfirmation !== "on") errors.push("E necessario confirmar maioridade.");
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
    const user = {
      id: store.nextId(data, "users"),
      name: String(name).trim(),
      cpfHash: hashCpf(normalizedCpf),
      cpfMasked: maskCpf(normalizedCpf),
      billingCpfCnpj: normalizedCpf,
      birthDate,
      email: normalizedEmail,
      phone: String(phone).trim(),
      passwordHash,
      role: "user",
      status: "active",
      walletBalance: 0,
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
    req.session.userId = user.id;
    req.flash("success", "Cadastro criado com sucesso.");
    return res.redirect("/app");
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
    user.lastLoginAt = todayIso();
    audit(data, user.id, "auth.login_success", "users", null, { lastLoginAt: user.lastLoginAt }, req);
    store.write(data);
    req.session.userId = user.id;
    return res.redirect(["admin", "super_admin"].includes(user.role) ? "/admin" : "/app");
  });

  app.post("/logout", (req, res) => {
    req.session.destroy(() => res.redirect("/"));
  });

  app.get("/recuperar", (req, res) => res.render("auth/recover", { title: "Recuperar senha" }));

  app.post("/recuperar", (req, res) => {
    const email = String(req.body.email || "").trim().toLowerCase();
    const data = store.read();
    normalizeData(data);
    const user = data.users.find((item) => item.email === email);
    if (user) {
      const token = crypto.randomBytes(24).toString("hex");
      data.passwordResets.push({
        id: store.nextId(data, "passwordResets"),
        userId: user.id,
        token,
        expiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
        usedAt: null,
        createdAt: todayIso()
      });
      audit(data, user.id, "auth.password_reset_requested", "passwordResets", null, { email }, req);
      store.write(data);
      req.flash("success", `Link local de redefinicao: /redefinir/${token}`);
    } else {
      req.flash("success", "Se o e-mail existir, enviaremos as instrucoes.");
    }
    return res.redirect("/recuperar");
  });

  app.post("/webhooks/asaas", (req, res) => {
    const expectedToken = process.env.ASAAS_WEBHOOK_TOKEN;
    if (expectedToken && req.get("asaas-access-token") !== expectedToken) {
      return res.status(401).json({ ok: false });
    }

    const data = store.read();
    normalizeData(data);
    const event = req.body?.event;
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
      const homeScore = Number(req.body[`home_${match.id}`]);
      const awayScore = Number(req.body[`away_${match.id}`]);
      if (!Number.isInteger(homeScore) || !Number.isInteger(awayScore) || homeScore < 0 || awayScore < 0) return;
      const existing = data.guesses.find(
        (guess) => guess.poolId === poolId && guess.matchId === match.id && guess.userId === user.id
      );
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
      pendingPayments: data.payments.filter((payment) => payment.type === "deposit" && payment.status === "awaiting").length,
      logs: data.auditLogs.slice(-8).reverse()
    });
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
    if (!req.body.name || !req.body.deadlineAt || entryValue < data.settings.depositMinimum) {
      req.flash("error", `Informe nome, prazo e entrada minima de R$ ${data.settings.depositMinimum},00.`);
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
    audit(data, user.id, "pool.created", "pools", null, pool, req);
    store.write(data);
    req.flash("success", "Bolao criado.");
    res.redirect("/admin/boloes");
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
      championships
    });
  });

  app.post("/admin/jogos", requireAuth, requireAdmin, (req, res) => {
    const data = store.read();
    normalizeData(data);
    const user = getCurrentUser(data, req);
    const poolId = Number(req.body.poolId);
    if (!data.pools.some((pool) => pool.id === poolId) || !championships.includes(req.body.championship)) {
      req.flash("error", "Bolao ou campeonato invalido.");
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
      homeTeam: String(req.body.homeTeam || "").trim(),
      awayTeam: String(req.body.awayTeam || "").trim(),
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

module.exports = { router };
