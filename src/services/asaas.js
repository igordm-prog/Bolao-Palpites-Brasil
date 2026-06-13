const { todayIso } = require("../utils");

function asaasConfig() {
  const apiKey = process.env.ASAAS_API_KEY;
  const env = process.env.ASAAS_ENV || "production";
  const baseUrl = process.env.ASAAS_BASE_URL || (env === "sandbox" ? "https://api-sandbox.asaas.com/v3" : "https://api.asaas.com/v3");
  return { apiKey, baseUrl };
}

function isAsaasEnabled() {
  return Boolean(asaasConfig().apiKey);
}

async function asaasRequest(path, { method = "GET", body } = {}) {
  const { apiKey, baseUrl } = asaasConfig();
  if (!apiKey) throw new Error("ASAAS_API_KEY nao configurada.");

  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      "User-Agent": "BolaoPalpitesBrasil/1.0",
      access_token: apiKey
    },
    body: body ? JSON.stringify(body) : undefined
  });

  const text = await response.text();
  const payload = text ? JSON.parse(text) : null;
  if (!response.ok) {
    const message =
      payload?.errors?.map((error) => error.description || error.message).join("; ") ||
      payload?.message ||
      `Erro Asaas HTTP ${response.status}`;
    throw new Error(message);
  }
  return payload;
}

async function ensureAsaasCustomer(data, user) {
  if (user.asaasCustomerId) return user.asaasCustomerId;
  if (!user.billingCpfCnpj) {
    throw new Error("Para criar esta cobranca e necessario preencher o CPF ou CNPJ do cliente.");
  }

  const customer = await asaasRequest("/customers", {
    method: "POST",
    body: {
      name: user.name,
      cpfCnpj: user.billingCpfCnpj,
      email: user.email,
      mobilePhone: user.phone,
      externalReference: `user-${user.id}`,
      notificationDisabled: true
    }
  });

  user.asaasCustomerId = customer.id;
  return customer.id;
}

function dueDateIso(days = 1) {
  const date = new Date();
  date.setDate(date.getDate() + days);
  return date.toISOString().slice(0, 10);
}

async function createPixDepositCharge(data, user, payment) {
  const customerId = await ensureAsaasCustomer(data, user);
  const externalReference = `wallet-deposit-${payment.id}`;
  const charge = await asaasRequest("/payments", {
    method: "POST",
    body: {
      customer: customerId,
      billingType: "PIX",
      value: Number(payment.amount || 0),
      dueDate: dueDateIso(1),
      description: `Deposito na carteira - ${data.settings.appName}`,
      externalReference
    }
  });

  const qrCode = await asaasRequest(`/payments/${charge.id}/pixQrCode`);

  payment.provider = "asaas";
  payment.providerPaymentId = charge.id;
  payment.providerStatus = charge.status;
  payment.externalReference = externalReference;
  payment.invoiceUrl = charge.invoiceUrl || null;
  payment.bankSlipUrl = charge.bankSlipUrl || null;
  payment.pixCode = qrCode.payload;
  payment.pixEncodedImage = qrCode.encodedImage;
  payment.pixExpirationDate = qrCode.expirationDate || null;
  payment.updatedAt = todayIso();

  return { charge, qrCode };
}

async function getAsaasPayment(paymentId) {
  return asaasRequest(`/payments/${paymentId}`);
}

function pixKeyTypeForCpfCnpj(cpfCnpj) {
  return String(cpfCnpj || "").length === 14 ? "CNPJ" : "CPF";
}

async function createPixWithdrawalTransfer(data, user, payment) {
  if (!user.billingCpfCnpj) {
    throw new Error("Para sacar automaticamente e necessario ter CPF ou CNPJ cadastrado.");
  }

  const externalReference = payment.externalReference || `wallet-withdrawal-${payment.id}`;
  const transfer = await asaasRequest("/transfers", {
    method: "POST",
    body: {
      value: Number(payment.amount || 0),
      operationType: "PIX",
      pixAddressKey: user.billingCpfCnpj,
      pixAddressKeyType: pixKeyTypeForCpfCnpj(user.billingCpfCnpj),
      description: `Saque da carteira - ${data.settings.appName}`,
      externalReference
    }
  });

  payment.provider = "asaas";
  payment.providerTransferId = transfer.id;
  payment.providerStatus = transfer.status;
  payment.externalReference = externalReference;
  payment.transactionId = transfer.id;
  payment.transferReceiptUrl = transfer.transactionReceiptUrl || null;
  payment.endToEndIdentifier = transfer.endToEndIdentifier || null;
  payment.payoutPixKey = user.billingCpfCnpj;
  payment.payoutPixKeyType = pixKeyTypeForCpfCnpj(user.billingCpfCnpj);
  payment.updatedAt = todayIso();

  return transfer;
}

module.exports = {
  isAsaasEnabled,
  asaasRequest,
  createPixDepositCharge,
  getAsaasPayment,
  createPixWithdrawalTransfer
};
