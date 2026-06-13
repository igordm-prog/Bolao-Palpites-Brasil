function flashMessages(req, res, next) {
  req.flash = (type, message) => {
    req.session.flash = req.session.flash || {};
    if (message !== undefined) {
      const messages = Array.isArray(message) ? message : [message];
      req.session.flash[type] = req.session.flash[type] || [];
      req.session.flash[type].push(...messages);
      return req.session.flash[type].length;
    }
    const messages = req.session.flash[type] || [];
    delete req.session.flash[type];
    return messages;
  };
  next();
}

module.exports = { flashMessages };
