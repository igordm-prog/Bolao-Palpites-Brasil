const crypto = require("crypto");

function onlyDigits(value = "") {
  return String(value).replace(/\D/g, "");
}

function hashCpf(cpf) {
  return crypto.createHash("sha256").update(onlyDigits(cpf)).digest("hex");
}

function maskCpf(cpf) {
  const digits = onlyDigits(cpf);
  if (digits.length !== 11) return "***.***.***-**";
  return `***.***.***-${digits.slice(-2)}`;
}

function isRealDateParts(year, month, day) {
  const date = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
  return (
    date.getUTCFullYear() === Number(year) &&
    date.getUTCMonth() === Number(month) - 1 &&
    date.getUTCDate() === Number(day)
  );
}

function normalizeBirthDate(value = "") {
  const raw = String(value).trim();
  const brMatch = raw.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (brMatch) {
    const [, day, month, year] = brMatch;
    if (!isRealDateParts(year, month, day)) return "";
    return `${year}-${month}-${day}`;
  }
  const isoMatch = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (isoMatch) {
    const [, year, month, day] = isoMatch;
    return isRealDateParts(year, month, day) ? raw : "";
  }
  return "";
}

function isValidEmail(email = "") {
  const normalized = String(email).trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(normalized) && normalized.length <= 254;
}

function isValidFullName(name = "") {
  const normalized = String(name)
    .trim()
    .replace(/\s+/g, " ");
  if (normalized.length < 6 || normalized.length > 120) return false;
  if (/\d|[<>{}[\]()/\\|_=+*@#$%^&;:!?]/.test(normalized)) return false;
  const parts = normalized.split(" ");
  if (parts.length < 2) return false;
  return parts.every((part) => /^[A-Za-zÀ-ÖØ-öø-ÿ'.-]{2,}$/.test(part));
}

function isValidPhone(phone = "") {
  const digits = onlyDigits(phone);
  if (![10, 11].includes(digits.length) || /^(\d)\1+$/.test(digits)) return false;
  const areaCode = Number(digits.slice(0, 2));
  if (areaCode < 11 || areaCode > 99) return false;
  if (digits.length === 11 && digits[2] !== "9") return false;
  return true;
}

function isValidCpf(cpf) {
  const digits = onlyDigits(cpf);
  if (digits.length !== 11 || /^(\d)\1+$/.test(digits)) return false;
  const calc = (length) => {
    let sum = 0;
    for (let i = 0; i < length; i += 1) {
      sum += Number(digits[i]) * (length + 1 - i);
    }
    const rest = (sum * 10) % 11;
    return rest === 10 ? 0 : rest;
  };
  return calc(9) === Number(digits[9]) && calc(10) === Number(digits[10]);
}

function isAdult(dateString) {
  const normalized = normalizeBirthDate(dateString);
  const birth = new Date(`${normalized}T00:00:00`);
  if (Number.isNaN(birth.getTime())) return false;
  const today = new Date();
  let age = today.getFullYear() - birth.getFullYear();
  const beforeBirthday =
    today.getMonth() < birth.getMonth() ||
    (today.getMonth() === birth.getMonth() && today.getDate() < birth.getDate());
  if (beforeBirthday) age -= 1;
  return age >= 18;
}

function strongPassword(password) {
  return (
    typeof password === "string" &&
    password.length >= 8 &&
    /[A-Z]/.test(password) &&
    /[a-z]/.test(password) &&
    /\d/.test(password) &&
    /[^A-Za-z0-9]/.test(password)
  );
}

function formatMoney(value) {
  return Number(value || 0).toLocaleString("pt-BR", {
    style: "currency",
    currency: "BRL"
  });
}

function formatDateTime(value) {
  if (!value) return "-";
  return new Date(value).toLocaleString("pt-BR", {
    dateStyle: "short",
    timeStyle: "short"
  });
}

function labelForStatus(status) {
  const labels = {
    active: "Ativo",
    awaiting: "Aguardando",
    awaiting_payment: "Aguardando pagamento",
    blocked: "Bloqueado",
    canceled: "Cancelado",
    closed: "Fechado",
    draft: "Rascunho",
    expired: "Expirado",
    finished: "Finalizado",
    open: "Aberto",
    paid: "Pago",
    refunded: "Estornado",
    scheduled: "Agendado"
  };
  return labels[status] || status || "-";
}

function labelForPaymentType(type) {
  const labels = {
    deposit: "Deposito",
    pool_entry: "Entrada em bolao",
    pool_refund: "Devolucao de bolao",
    withdrawal: "Saque"
  };
  return labels[type] || type || "-";
}

function labelForPaymentMethod(method) {
  const labels = {
    PIX: "PIX",
    WALLET: "Carteira"
  };
  return labels[method] || method || "-";
}

function labelForRole(role) {
  const labels = {
    super_admin: "Super admin",
    admin: "Administrador",
    user: "Usuario"
  };
  return labels[role] || role || "-";
}

function labelForAuditAction(action) {
  const labels = {
    "auth.login_success": "Login realizado",
    "auth.login_failed": "Falha no login",
    "auth.password_reset_requested": "Redefinicao solicitada",
    "auth.password_reset_completed": "Senha redefinida",
    "user.registered": "Usuario cadastrado",
    "user.status_changed": "Status do usuario alterado",
    "pool.created": "Bolao criado",
    "pool.status_changed": "Status do bolao alterado",
    "pool.audit_generated": "Auditoria do bolao gerada",
    "pool.canceled": "Bolao cancelado",
    "pool.deleted": "Bolao excluido",
    "match.created": "Jogo cadastrado",
    "match.deleted": "Jogo excluido",
    "match.result_entered": "Resultado lancado",
    "payment.created": "Pagamento criado",
    "payment.status_changed": "Status do pagamento alterado",
    "wallet.deposit_created": "Deposito criado",
    "wallet.deposit_credited": "Deposito creditado",
    "wallet.deposit_reversed": "Deposito estornado",
    "wallet.pool_entry_debited": "Entrada debitada da carteira",
    "wallet.pending_entry_debited": "Entrada pendente debitada",
    "wallet.pool_entry_refunded": "Entrada devolvida para carteira",
    "wallet.withdrawal_requested": "Saque solicitado",
    "wallet.withdrawal_paid": "Saque pago",
    "wallet.withdrawal_canceled": "Saque cancelado",
    "guess.saved": "Palpite salvo",
    "lgpd.deletion_requested": "Exclusao solicitada",
    "system.production_reset": "Sistema limpo para producao"
  };
  return labels[action] || action || "-";
}

function labelForTableName(tableName) {
  const labels = {
    guesses: "Palpites",
    matches: "Jogos",
    participants: "Participantes",
    participations: "Participacoes",
    passwordResets: "Redefinicoes de senha",
    payments: "Pagamentos",
    pools: "Boloes",
    users: "Usuarios"
  };
  return labels[tableName] || tableName || "-";
}

function todayIso() {
  return new Date().toISOString();
}

function isWeekend(dateString) {
  const date = new Date(`${dateString}T12:00:00`);
  const day = date.getDay();
  return day === 0 || day === 6;
}

function publicUser(user) {
  if (!user) return null;
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    role: user.role,
    status: user.status,
    cpfMasked: user.cpfMasked,
    walletBalance: user.walletBalance || 0
  };
}

module.exports = {
  onlyDigits,
  normalizeBirthDate,
  hashCpf,
  maskCpf,
  isValidEmail,
  isValidFullName,
  isValidPhone,
  isValidCpf,
  isAdult,
  strongPassword,
  formatMoney,
  formatDateTime,
  labelForStatus,
  labelForPaymentType,
  labelForPaymentMethod,
  labelForRole,
  labelForAuditAction,
  labelForTableName,
  todayIso,
  isWeekend,
  publicUser
};
