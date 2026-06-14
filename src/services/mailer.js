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
  const config = mailConfig();
  const transporter = createTransporter();
  const subject = "Codigo de recuperacao de senha";
  const text = [
    `Ola, ${user.name}.`,
    "",
    `Seu codigo de recuperacao do Bolao Palpites Brasil e: ${code}`,
    "Ele expira em 15 minutos.",
    "",
    "Se voce nao solicitou esta recuperacao, ignore este e-mail."
  ].join("\n");

  const html = `
    <div style="font-family:Arial,sans-serif;line-height:1.5;color:#111">
      <h2>Recuperacao de senha</h2>
      <p>Ola, ${user.name}.</p>
      <p>Seu codigo de recuperacao do <strong>Bolao Palpites Brasil</strong> e:</p>
      <p style="font-size:28px;font-weight:800;letter-spacing:4px">${code}</p>
      <p>Ele expira em 15 minutos.</p>
      <p>Se voce nao solicitou esta recuperacao, ignore este e-mail.</p>
    </div>
  `;

  return transporter.sendMail({
    from: config.from,
    to: user.email,
    subject,
    text,
    html
  });
}

module.exports = {
  isEmailEnabled,
  sendPasswordResetCode
};
