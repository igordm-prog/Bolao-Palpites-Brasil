const bcrypt = require("bcryptjs");
const { hashCpf, maskCpf, todayIso } = require("../utils");

function ensureSeedData(store) {
  store.update((data) => {
    if (!data.users.some((user) => user.role === "super_admin")) {
      data.users.push({
        id: store.nextId(data, "users"),
        name: "Administrador",
        cpfHash: hashCpf("39053344705"),
        cpfMasked: maskCpf("39053344705"),
        birthDate: "1990-01-01",
        email: process.env.ADMIN_EMAIL || "admin@bolaobrasilplacares.com.br",
        phone: "(00) 90000-0000",
        passwordHash: bcrypt.hashSync(process.env.ADMIN_PASSWORD || "Admin@123", 12),
        role: "super_admin",
        status: "active",
        walletBalance: 0,
        acceptedTermsAt: todayIso(),
        acceptedPrivacyAt: todayIso(),
        lastLoginAt: null,
        failedLoginCount: 0,
        lockedUntil: null,
        createdAt: todayIso()
      });
    }
  });
}

module.exports = { ensureSeedData };
