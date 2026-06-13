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
  const birth = new Date(`${dateString}T00:00:00`);
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
    "match.created": "Jogo cadastrado",
    "match.result_entered": "Resultado lancado",
    "payment.created": "Pagamento criado",
    "payment.status_changed": "Status do pagamento alterado",
    "wallet.deposit_created": "Deposito criado",
    "wallet.deposit_credited": "Deposito creditado",
    "wallet.deposit_reversed": "Deposito estornado",
    "wallet.pool_entry_debited": "Entrada debitada da carteira",
    "wallet.pending_entry_debited": "Entrada pendente debitada",
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
  hashCpf,
  maskCpf,
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
