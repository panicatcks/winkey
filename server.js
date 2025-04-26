require('dotenv').config();

const express = require('express');
const path = require('path');
const session = require('express-session');
const connectPgSimple = require('connect-pg-simple')(session);
const bcrypt = require('bcrypt');
const cookieParser = require('cookie-parser');
const multer = require('multer');
const fs = require('fs');
const app = express();
const PORT = process.env.PORT || 3000;

const publicRoutes = require('./routes/public');
const authRoutes = require('./routes/auth');
const adminRoutes = require('./routes/admin');
const apiRoutes = require('./routes/api');

const digisellerUtils = require('./utils/digiseller');
const cartUtils = require('./utils/cart');
const settingsUtils = require('./utils/settings');

const { pool, initDb } = require('./db');

const { isAuthenticated, isAdmin } = require('./middleware/auth');
const setLocale = require('./middleware/locale');

const uploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir);
}

const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, uploadDir);
  },
  filename: function (req, file, cb) {
    cb(null, Date.now() + '-' + file.originalname);
  }
});

const upload = multer({ storage: storage });

const sessionStore = new connectPgSimple({ pool: pool, tableName: 'user_sessions' });

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());
app.use(setLocale);

app.use((req, res, next) => {
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; " +
    "script-src 'self' 'unsafe-inline' 'unsafe-eval' https://cdn.jsdelivr.net https://unpkg.com https://code.jquery.com; " +
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://cdn.jsdelivr.net https://unpkg.com; " +
    "font-src 'self' data: https://fonts.gstatic.com; " +
    "img-src 'self' data: https://graph.digiseller.ru https://www.digiseller.market; " +
    "connect-src 'self';"
  );
  next();
});

app.use((req, res, next) => {
  const locale = req.cookies.locale || 'en'; 
  res.locals.locale = locale;
  next();
});

app.use('/uploads', express.static(uploadDir));

app.use('/assets', express.static(path.join(__dirname, 'assets')));
app.use('/vendor', express.static(path.join(__dirname, 'vendor')));
app.use(session({
  store: sessionStore,
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: process.env.NODE_ENV === 'production',
    sameSite: process.env.NODE_ENV === 'production' ? 'lax' : 'strict',
    maxAge: 24 * 60 * 60 * 1000
  }
}));

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

app.use('/', publicRoutes.router);
app.use('/', authRoutes.router);
app.use('/admin', adminRoutes.router);
app.use('/api', apiRoutes.router);

adminRoutes.setDependencies(
  upload, 
  digisellerUtils.syncProductsFromDigiseller, 
  digisellerUtils.updateDigisellerProduct,
  digisellerUtils.createDigisellerProduct
);
apiRoutes.setDependencies(isAuthenticated, isAdmin);

app.get('/login', (req, res) => {
  res.render('login', {
    title: 'WinKey - Login',
    activePage: 'login',
    pageName: 'login'
  });
});

app.post('/login', async (req, res) => {
  try {
    const { username, password } = req.body;

    const result = await pool.query('SELECT * FROM users WHERE username = $1', [username]);

    if (result.rows.length === 0) {
      return res.render('login', {
        error: 'Invalid username or password',
        title: 'WinKey - Login',
        activePage: 'login',
        pageName: 'login'
      });
    }

    const user = result.rows[0];

    if (user.is_banned) {
      return res.render('login', {
        error: 'Your account has been banned',
        title: 'WinKey - Login',
        activePage: 'login',
        pageName: 'login'
      });
    }

    const isPasswordValid = await bcrypt.compare(password, user.password);

    if (!isPasswordValid) {
      return res.render('login', {
        error: 'Invalid username or password',
        title: 'WinKey - Login',
        activePage: 'login',
        pageName: 'login'
      });
    }

    req.session.user = {
      id: user.id,
      username: user.username,
      email: user.email,
      role: user.role
    };

    req.session.save(async (err) => {
        if (err) {
            console.error('Session save error:', err);
            return res.render('login', {
                error: 'An error occurred during login (session save).',
                title: 'WinKey - Login',
                activePage: 'login',
                pageName: 'login'
            });
        }
        try {
          await cartUtils.moveCartItemsToDatabase(req);
          res.redirect('/');
        } catch (cartErr) {
           console.error(`Error moving cart items for ${username}:`, cartErr);
           res.redirect('/');
        }
    });

  } catch (err) {
    res.render('login', { 
      error: 'An error occurred during login',
      title: 'WinKey - Login',
      activePage: 'login',
      pageName: 'login'
    });
  }
});

app.get('/register', (req, res) => {
  res.render('register', {
    title: 'WinKey - Register',
    activePage: 'register',
    pageName: 'register'
  });
});

app.post('/register', async (req, res) => {
  try {
    const { username, email, password } = req.body;
    const hashedPassword = await bcrypt.hash(password, 10);
    
    await pool.query(
      'INSERT INTO users (username, email, password) VALUES ($1, $2, $3)',
      [username, email, hashedPassword]
    );
    
    res.redirect('/login');
  } catch (err) {
    console.error(err);
    res.render('register', { 
      error: 'Username or email already exists',
      title: 'WinKey - Register',
      activePage: 'register',
      pageName: 'register'
    });
  }
});

app.get('/logout', (req, res) => {
  req.session.destroy((err) => {
    if (err) {
      console.error("Error destroying session:", err);
      return res.status(500).send("Could not log out.");
    }
    res.redirect('/');
  });
});

app.get('/profile', isAuthenticated, async (req, res) => {
  try {
    const userId = req.session.user.id;
    const userResult = await pool.query('SELECT id, username, email, role, created_at FROM users WHERE id = $1', [userId]);
    const purchasesResult = await pool.query(`
      SELECT p.id, pr.name as product_name, p.price_usd, p.price_rub, p.purchase_date
      FROM purchases p
      LEFT JOIN products pr ON p.product_id = pr.id -- Use LEFT JOIN in case product deleted
      WHERE p.user_id = $1
      ORDER BY p.purchase_date DESC
    `, [userId]);
    
    if (userResult.rows.length === 0) {
      return res.redirect('/login'); 
    }
    
    res.render('profile', {
      title: 'WinKey - Profile',
      activePage: 'profile',
      pageName: 'profile',
      user: userResult.rows[0],
      purchases: purchasesResult.rows
    });
  } catch (err) {
    console.error("Error fetching profile:", err);
    res.status(500).render('error', { title: 'Server Error', message: 'Could not load profile.', user: req.session.user });
  }
});


// API для проверки аутентификации (совместимость)
app.get('/api/check-auth', (req, res) => {
  if (req.session.user) {
    res.json({
      isAuthenticated: true,
      username: req.session.user.username,
      email: req.session.user.email,
      isAdmin: req.session.user.role === 'admin'
    });
  } else {
    res.json({
      isAuthenticated: false
    });
  }
});

// Маршрут для отображения деталей продукта в формате HTML
app.get('/product/:id', async (req, res) => {
  try {
    const productId = req.params.id;
    const result = await pool.query('SELECT * FROM products WHERE id = $1', [productId]);
    
    if (result.rows.length === 0) {
      return res.status(404).send('Product not found');
    }
    
    const product = result.rows[0];
    
    const userSettings = req.session.user ? 
      await settingsUtils.getUserSettings(req.session.user.id) : 
      { language: 'en', currency: 'USD' };
    
    res.render('product-details', { 
      product,
      user: req.session.user || null,
      settings: userSettings
    });
  } catch (err) {
    console.error(err);
    res.status(500).send('Server error');
  }
});

app.use((req, res) => {
  res.status(404).render('404', { 
    title: 'Page Not Found', 
    user: req.session.user,
    pageName: '404',
    activePage: '404'
  });
});

initDb()
  .then(() => {
    digisellerUtils.setDbPool(pool);
    
    settingsUtils.setDbPool(pool);
    
    cartUtils.setDbPool(pool);

    digisellerUtils.startDigisellerSync(); 
    
    app.listen(PORT, () => {
      console.log(`Server running on port ${PORT}`);
    });
  })
  .catch(err => {
      console.error("Failed to initialize database or start server:", err);
      process.exit(1);
  }); 