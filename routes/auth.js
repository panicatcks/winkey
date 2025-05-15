const express = require('express');
const bcrypt = require('bcrypt');
const { pool } = require('../db');
const { moveCartItemsToDatabase } = require('../utils/cart');

const router = express.Router();

// Route: GET /login
router.get('/login', (req, res) => {
  if (req.session.user) {
      return res.redirect('/');
  }
  res.render('login', {
    title: 'WinKey - Login',
    activePage: 'login',
    pageName: 'login',
    user: null
  });
});

// Route: POST /login
router.post('/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    const result = await pool.query('SELECT * FROM users WHERE username = $1', [username]);

    if (result.rows.length === 0) {
      return res.render('login', {
        error: 'Invalid username or password',
        title: 'WinKey - Login',
        activePage: 'login',
        pageName: 'login',
        user: null
      });
    }

    const user = result.rows[0];

    if (user.is_banned) {
      return res.render('login', {
        error: 'Your account has been banned',
        title: 'WinKey - Login',
        activePage: 'login',
        pageName: 'login',
        user: null
      });
    }

    const isPasswordValid = await bcrypt.compare(password, user.password);

    if (!isPasswordValid) {
      return res.render('login', {
        error: 'Invalid username or password',
        title: 'WinKey - Login',
        activePage: 'login',
        pageName: 'login',
        user: null
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
          pageName: 'login',
          user: null
        });
      }
      try {
        await moveCartItemsToDatabase(req);
        res.redirect('/');
      } catch (cartErr) {
        console.error(`Error moving cart items for ${username}:`, cartErr);
        res.redirect('/');
      }
    });

  } catch (err) {
      console.error("Login POST error:", err);
      res.render('login', {
        error: 'An error occurred during login',
        title: 'WinKey - Login',
        activePage: 'login',
        pageName: 'login',
        user: null
      });
  }
});

// Route: GET /register
router.get('/register', (req, res) => {
  if (req.session.user) {
      return res.redirect('/');
  }
  res.render('register', {
    title: 'WinKey - Register',
    activePage: 'register',
    pageName: 'register',
    user: null
  });
});

// Route: POST /register
router.post('/register', async (req, res) => {
  try {
    const { username, email, password } = req.body;
    
    if (!username || !email || !password) {
        return res.render('register', {
            error: 'Username, email, and password are required.',
            title: 'WinKey - Register',
            activePage: 'register',
            pageName: 'register',
            user: null
        });
    }
    
    const hashedPassword = await bcrypt.hash(password, 10);

    await pool.query(
      'INSERT INTO users (username, email, password) VALUES ($1, $2, $3)',
      [username, email, hashedPassword]
    );

    res.redirect('/login');
  } catch (err) {
    console.error('Registration error:', err);
    let errorMessage = 'An error occurred during registration.';
    if (err.code === '23505') {
        errorMessage = 'Username or email already exists.';
    }
    res.render('register', {
      error: errorMessage,
      title: 'WinKey - Register',
      activePage: 'register',
      pageName: 'register',
      user: null
    });
  }
});

// Route: GET /logout
router.get('/logout', (req, res) => {
  req.session.destroy((err) => {
    if (err) {
      console.error("Error destroying session:", err);
      return res.status(500).send("Could not log out.");
    }
    res.clearCookie('connect.sid');
    res.redirect('/');
  });
});

module.exports = { router }; 