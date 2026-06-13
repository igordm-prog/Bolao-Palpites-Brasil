function requireAuth(req, res, next) {
  if (!req.session.userId) {
    req.flash("error", "Entre para continuar.");
    return res.redirect("/login");
  }
  return next();
}

function requireAdmin(req, res, next) {
  const user = res.locals.currentUser;
  if (!user || !["admin", "super_admin"].includes(user.role)) {
    req.flash("error", "Acesso restrito ao administrador.");
    return res.redirect("/app");
  }
  return next();
}

module.exports = { requireAuth, requireAdmin };
