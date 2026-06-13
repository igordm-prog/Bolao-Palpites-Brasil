function resultOf(home, away) {
  if (home > away) return "home";
  if (home < away) return "away";
  return "draw";
}

function scoreGuess(guess, match) {
  if (
    guess.homeScore == null ||
    guess.awayScore == null ||
    match.homeScore == null ||
    match.awayScore == null
  ) {
    return { points: 0, category: "pending" };
  }

  if (guess.homeScore === match.homeScore && guess.awayScore === match.awayScore) {
    return { points: 5, category: "exact" };
  }

  if (resultOf(guess.homeScore, guess.awayScore) === resultOf(match.homeScore, match.awayScore)) {
    return { points: 2, category: "result" };
  }

  if (guess.homeScore === match.homeScore || guess.awayScore === match.awayScore) {
    return { points: 1, category: "side" };
  }

  return { points: 0, category: "none" };
}

function recalculatePool(data, poolId) {
  const matches = data.matches.filter((match) => match.poolId === poolId);
  const matchMap = new Map(matches.map((match) => [match.id, match]));
  data.guesses
    .filter((guess) => guess.poolId === poolId)
    .forEach((guess) => {
      const match = matchMap.get(guess.matchId);
      const result = match ? scoreGuess(guess, match) : { points: 0, category: "pending" };
      guess.points = result.points;
      guess.category = result.category;
    });
}

function rankingForPool(data, poolId) {
  const paidUserIds = new Set(
    data.participations
      .filter((participation) => participation.poolId === poolId && participation.status === "paid")
      .map((participation) => participation.userId)
  );

  const rows = [...paidUserIds].map((userId) => {
    const user = data.users.find((item) => item.id === userId);
    const guesses = data.guesses.filter((guess) => guess.poolId === poolId && guess.userId === userId);
    const firstGuessAt = guesses.reduce((first, guess) => {
      if (!guess.createdAt) return first;
      if (!first || new Date(guess.createdAt) < new Date(first)) return guess.createdAt;
      return first;
    }, null);

    return {
      userId,
      name: user?.name || "Participante",
      total: guesses.reduce((sum, guess) => sum + (guess.points || 0), 0),
      exact: guesses.filter((guess) => guess.category === "exact").length,
      result: guesses.filter((guess) => guess.category === "result").length,
      side: guesses.filter((guess) => guess.category === "side").length,
      firstGuessAt
    };
  });

  rows.sort((a, b) => {
    if (b.total !== a.total) return b.total - a.total;
    if (b.exact !== a.exact) return b.exact - a.exact;
    if (b.result !== a.result) return b.result - a.result;
    if (b.side !== a.side) return b.side - a.side;
    if (!a.firstGuessAt && b.firstGuessAt) return 1;
    if (a.firstGuessAt && !b.firstGuessAt) return -1;
    return new Date(a.firstGuessAt || 0) - new Date(b.firstGuessAt || 0);
  });

  return rows.map((row, index) => ({ ...row, position: index + 1 }));
}

module.exports = { scoreGuess, recalculatePool, rankingForPool };
