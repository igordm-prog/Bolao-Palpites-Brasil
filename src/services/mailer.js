const nodemailer = require("nodemailer");

function mailConfig() {
  return {
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 587),
    secure: String(process.env.SMTP_SECURE || "false").toLowerCase() === "true",
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
    from: process.env.SMTP_FROM || process.env.SMTP_USER,
    appUrl: process.env.APP_URL || "http://localhost:3000"
  };
}

function isEmailEnabled() {
  const config = mailConfig();
  return Boolean(config.host && config.user && config.pass && config.from);
}

function createTransporter() {
  const config = mailConfig();
  if (!isEmailEnabled()) {
    throw new Error("SMTP nao configurado.");
  }
  return nodemailer.createTransport({
    host: config.host,
    port: config.port,
    secure: config.secure,
    auth: {
      user: config.user,
      pass: config.pass
    }
  });
}

async function sendPasswordResetCode(user, code) {
  return sendSecurityCodeEmail(user, code, {
    subject: "Codigo de recuperacao de senha",
    title: "Recuperacao de senha",
    intro: "Seu codigo de recuperacao do Bolao Palpites Brasil e:",
    warning: "Se voce nao solicitou esta recuperacao, ignore este e-mail."
  });
}

async function sendEmailVerificationCode(user, code) {
  return sendSecurityCodeEmail(user, code, {
    subject: "Codigo de validacao do e-mail",
    title: "Validacao de e-mail",
    intro: "Seu codigo para validar o e-mail da conta e:",
    warning: "Se voce nao solicitou esta validacao, acesse sua conta e altere a senha."
  });
}

async function sendWithdrawalCode(user, code, amountLabel) {
  return sendSecurityCodeEmail(user, code, {
    subject: "Codigo de confirmacao de saque",
    title: "Confirmacao de saque",
    intro: `Seu codigo para confirmar o saque de ${amountLabel} e:`,
    warning: "Se voce nao solicitou este saque, nao informe este codigo para ninguem e altere sua senha."
  });
}

async function sendSecurityCodeEmail(user, code, content) {
  const config = mailConfig();
  const transporter = createTransporter();
  const text = [
    `Ola, ${user.name}.`,
    "",
    `${content.intro} ${code}`,
    "Ele expira em 15 minutos.",
    "",
    content.warning
  ].join("\n");

  const html = `
    <div style="font-family:Arial,sans-serif;line-height:1.5;color:#111">
      <h2>${content.title}</h2>
      <p>Ola, ${user.name}.</p>
      <p>${content.intro}</p>
      <p style="font-size:28px;font-weight:800;letter-spacing:4px">${code}</p>
      <p>Ele expira em 15 minutos.</p>
      <p>${content.warning}</p>
    </div>
  `;

  return transporter.sendMail({
    from: config.from,
    to: user.email,
    subject: content.subject,
    text,
    html
  });
}

module.exports = {
  isEmailEnabled,
  sendEmailVerificationCode,
  sendPasswordResetCode,
  sendWithdrawalCode
};
