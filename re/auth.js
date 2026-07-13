// auth.js
// Session-based login + per-table permission checks.

const usersLib = require('./users');

function loadCurrentUser(req, res, next) {
  if (req.session && req.session.userId) {
    const user = usersLib.getById(req.session.userId);
    if (!user) {
      req.session.destroy(() => {});
      return res.redirect('/login');
    }
    req.currentUser = user;
  }
  res.locals.currentUser = req.currentUser || null;
  next();
}

function requireLogin(req, res, next) {
  if (req.currentUser) return next();
  const next_ = encodeURIComponent(req.originalUrl || '/');
  return res.redirect(`/login?next=${next_}`);
}

function requireAdmin(req, res, next) {
  if (req.currentUser && req.currentUser.isAdmin) return next();
  return res.status(403).render('403', { message: 'This area is restricted to administrators.', activeKey: '' });
}

function requirePermission(action) {
  return function (req, res, next) {
    const entity = req.entity;
    if (usersLib.can(req.currentUser, entity.key, action)) return next();
    return res.status(403).render('403', {
      message: `You don't have ${action} permission on ${entity.label}. Ask an administrator to grant it under Admin \u2192 Users.`,
      activeKey: entity.key,
    });
  };
}

module.exports = { loadCurrentUser, requireLogin, requireAdmin, requirePermission };
