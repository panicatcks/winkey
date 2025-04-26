function setLocale(req, res, next) {
  const locale = req.cookies.locale || 'en'; 
  res.locals.locale = locale;
  next();
}

module.exports = setLocale; 