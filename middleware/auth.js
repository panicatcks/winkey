function isAuthenticated(req, res, next) {
  if (req.session.user) {
    return next();
  }
  res.redirect('/login');
}

function isAdmin(req, res, next) {
  if (req.session.user && req.session.user.role === 'admin') {
    return next();
  }
  res.status(403).render('error', { 
      title: 'Access Denied', 
      message: 'You do not have permission to access this page.',
      user: req.session.user
  });
}

module.exports = {
    isAuthenticated,
    isAdmin
}; 