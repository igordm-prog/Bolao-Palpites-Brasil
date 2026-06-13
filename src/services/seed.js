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

    let poolId = data.pools.find((pool) => pool.name === "Bolao Rodada Demo - Series A/B Sabado e Domingo")?.id;
    if (!poolId) {
      poolId = store.nextId(data, "pools");
      data.pools.push({
        id: poolId,
        name: "Bolao Rodada Demo - Series A/B Sabado e Domingo",
        round: "Demo",
        startsAt: todayIso(),
        deadlineAt: new Date(Date.now() + 1000 * 60 * 60 * 24 * 3).toISOString(),
        entryValue: 20,
        adminFeePercent: data.settings.entryAdminFeePercent,
        status: "open",
        prizeModel: "winner_take_all",
        createdAt: todayIso()
      });
    }

    const demoMatches = [
      ["Serie A", "Flamengo", "Palmeiras", "2026-06-13", "16:00", "Maracana"],
      ["Serie A", "Corinthians", "Gremio", "2026-06-13", "18:30", "Neo Quimica Arena"],
      ["Serie A", "Atletico Mineiro", "Sao Paulo", "2026-06-13", "21:00", "Arena MRV"],
      ["Serie A", "Internacional", "Cruzeiro", "2026-06-14", "11:00", "Beira-Rio"],
      ["Serie A", "Botafogo", "Bahia", "2026-06-14", "16:00", "Nilton Santos"],
      ["Serie A", "Vasco", "Athletico-PR", "2026-06-14", "18:30", "Sao Januario"],
      ["Serie B", "Ceara", "Sport", "2026-06-13", "16:00", "Castelao"],
      ["Serie B", "Goias", "Coritiba", "2026-06-13", "18:30", "Serrinha"],
      ["Serie B", "Novorizontino", "Vila Nova", "2026-06-13", "20:30", "Jorge Ismael"],
      ["Serie B", "Avai", "Chapecoense", "2026-06-14", "16:30", "Ressacada"],
      ["Serie B", "CRB", "Amazonas", "2026-06-14", "18:30", "Rei Pele"],
      ["Serie B", "Mirassol", "Ponte Preta", "2026-06-14", "16:00", "Maiao"],
      ["Serie B", "Operario", "Ituano", "2026-06-14", "18:00", "Germano Kruger"],
      ["Serie B", "Brusque", "Sampaio Correa", "2026-06-14", "17:00", "Augusto Bauer"],
      ["Serie B", "Juventude", "Londrina", "2026-06-14", "18:30", "Alfredo Jaconi"],
      ["Serie B", "Guarani", "Tombense", "2026-06-14", "20:30", "Brinco de Ouro"]
    ];

    demoMatches.forEach(([championship, homeTeam, awayTeam, matchDate, matchTime, venue]) => {
      const exists = data.matches.some(
        (match) => match.poolId === poolId && match.homeTeam === homeTeam && match.awayTeam === awayTeam
      );
      if (!exists) {
        data.matches.push({
          id: store.nextId(data, "matches"),
          poolId,
          championship,
          round: "Demo",
          homeTeam,
          awayTeam,
          matchDate,
          matchTime,
          venue,
          homeScore: null,
          awayScore: null,
          status: "scheduled",
          createdAt: todayIso()
        });
      }
    });
  });
}

module.exports = { ensureSeedData };
