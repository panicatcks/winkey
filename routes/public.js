const express = require('express');
const path = require('path');
const { pool } = require('../db'); 
const { getUserSettings } = require('../utils/settings'); 

const router = express.Router();

// Route: /
router.get('/', async (req, res) => {
  try {
    // Get trending products (limit to 4)
    const trendingResult = await pool.query(`
      SELECT * FROM products 
      ORDER BY id DESC
      LIMIT 4
    `);
    
    // Get most played products (limit to 6)
    const mostPlayedResult = await pool.query(`
      SELECT * FROM products 
      ORDER BY id DESC
      LIMIT 6 OFFSET 4
    `);
    
    // Get user settings for proper currency display
    const userSettings = req.session.user ? 
      await getUserSettings(req.session.user.id) : 
      { language: res.locals.locale || 'en', currency: 'USD' };
    
    res.render('index', {
      title: 'Winkey - Home',
      activePage: 'home',
      pageName: 'home',
      user: req.session.user,
      trendingProducts: trendingResult.rows,
      mostPlayedProducts: mostPlayedResult.rows,
      settings: userSettings
    });
  } catch (err) {
    console.error('Error fetching products for homepage:', err);
    res.render('index', {
      title: 'Winkey - Home',
      activePage: 'home',
      pageName: 'home',
      user: req.session.user,
      trendingProducts: [],
      mostPlayedProducts: [],
      settings: { language: res.locals.locale || 'en', currency: 'USD' }
    });
  }
});

// Route: /shop
router.get('/shop', async (req, res) => {
  try {
    const searchKeyword = req.query.searchKeyword;
    let query = 'SELECT * FROM products';
    let params = [];

    if (searchKeyword) {
      query = `
        SELECT * FROM products 
        WHERE name ILIKE $1 
        OR name_ru ILIKE $1 
        OR description ILIKE $1 
        OR description_ru ILIKE $1
      `;
      params = [`%${searchKeyword}%`];
    }

    query += ' ORDER BY id';
    const result = await pool.query(query, params);

    res.render('shop', {
      title: 'Winkey - Shop',
      activePage: 'shop',
      pageName: 'shop',
      products: result.rows,
      user: req.session.user,
      searchKeyword: searchKeyword
    });
  } catch (err) {
    console.error('Error fetching products:', err);
    res.render('shop', {
      title: 'Winkey - Shop',
      activePage: 'shop',
      pageName: 'shop',
      products: [],
      user: req.session.user,
      error: 'Could not load products.'
    });
  }
});

// Route: /product-details (used by clicking on product from shop)
router.get('/product-details', async (req, res) => {
  const productId = req.query.id;
  try {
    let product;
    if (productId) {
      const result = await pool.query('SELECT * FROM products WHERE id = $1', [productId]);
      if (result.rows.length > 0) {
        product = result.rows[0];
      }
    }
    
    const userSettings = req.session.user ?
      await getUserSettings(req.session.user.id) :
      { language: res.locals.locale || 'en', currency: 'USD' };
    
    res.render('product-details', {
      title: product ? `WinKey - ${product.name}` : 'WinKey - Product Details',
      activePage: 'product-details',
      pageName: 'product-details',
      product: product,
      user: req.session.user,
      settings: userSettings
    });
  } catch (err) {
    console.error('Error fetching product details:', err);
    res.render('product-details', {
      title: 'WinKey - Product Details',
      activePage: 'shop',
      pageName: 'product-details',
      product: undefined,
      user: req.session.user,
      error: 'Could not load product details.',
      settings: { language: res.locals.locale || 'en', currency: 'USD' }
    });
  }
});

// Route: /product/:id (Direct link or specific product view)
router.get('/product/:id', async (req, res) => {
  try {
    const productId = req.params.id;
    const result = await pool.query('SELECT * FROM products WHERE id = $1', [productId]);

    if (result.rows.length === 0) {
      return res.status(404).render('404', {
         title: 'Product Not Found', 
         user: req.session.user,
         pageName: '404'
      });
    }

    const product = result.rows[0];
    const userSettings = req.session.user ?
      await getUserSettings(req.session.user.id) :
      { language: res.locals.locale || 'en', currency: 'USD' };

    res.redirect(`/product-details?id=${productId}`);
  } catch (err) {
    console.error('Error in /product/:id route:', err);
    res.status(500).render('error', {
       title: 'Server Error', 
       message: 'Could not load product details.',
       user: req.session.user,
       pageName: 'error'
    });
  }
});

// Route: /checkout
router.get('/checkout', async (req, res) => {
  try {
    const parseItemPrices = (item) => ({
      ...item,
      price_usd: parseFloat(item.price_usd),
      price_rub: parseFloat(item.price_rub),
      discounted_price_usd: item.discounted_price_usd ? parseFloat(item.discounted_price_usd) : null,
      discounted_price_rub: item.discounted_price_rub ? parseFloat(item.discounted_price_rub) : null,
    });

    let cartItems = [];
    let total = 0;
    
    if (req.session.user) {
      const cartResult = await pool.query(`
        SELECT ci.product_id, ci.quantity, p.name, p.price_usd, p.price_rub, 
               p.discounted_price_usd, p.discounted_price_rub, p.image_url 
        FROM cart_items ci
        JOIN products p ON ci.product_id = p.id
        WHERE ci.user_id = $1
      `, [req.session.user.id]);
      
      cartItems = cartResult.rows.map(parseItemPrices);
    } else if (req.session.cart && req.session.cart.length > 0) {
      const productIds = req.session.cart.map(item => item.product_id);
      const productsResult = await pool.query(`
        SELECT id, name, price_usd, price_rub, discounted_price_usd, discounted_price_rub, image_url 
        FROM products 
        WHERE id = ANY($1)
      `, [productIds]);
      
      const productMap = new Map(productsResult.rows.map(p => [p.id, p]));
      
      cartItems = req.session.cart.map(item => {
        const product = productMap.get(item.product_id);
        if (!product) {
          console.warn(`Product with ID ${item.product_id} found in session cart but not in DB. Skipping.`);
          return null;
        }
        return parseItemPrices({
          product_id: item.product_id,
          quantity: item.quantity,
          name: product.name,
          price_usd: product.price_usd,
          price_rub: product.price_rub,
          discounted_price_usd: product.discounted_price_usd,
          discounted_price_rub: product.discounted_price_rub,
          image_url: product.image_url
        });
      }).filter(item => item !== null);
    }
    
    const userSettings = req.session.user ? 
      await getUserSettings(req.session.user.id) : 
      { language: res.locals.locale || 'en', currency: 'USD' };
    
    const currency = userSettings.currency || 'USD';
    if (currency === 'USD') {
      total = cartItems.reduce((sum, item) => {
        const price = item.discounted_price_usd || item.price_usd;
        return sum + (price * item.quantity);
      }, 0);
    } else {
      total = cartItems.reduce((sum, item) => {
        const price = item.discounted_price_rub || item.price_rub;
        return sum + (price * item.quantity);
      }, 0);
    }
    
    res.render('checkout', {
      title: 'WinKey - Checkout',
      activePage: 'checkout',
      pageName: 'checkout',
      user: req.session.user,
      cartItems: cartItems,
      total: total,
      currency: currency,
      settings: userSettings
    });
  } catch (err) {
    console.error('Error rendering checkout page:', err);
    res.status(500).render('error', {
      title: 'Server Error',
      message: 'Could not load checkout page.',
      user: req.session.user
    });
  }
});

// Route: /cart
router.get('/cart', async (req, res) => {
  try {
    let cartItems = [];
    let total = 0;
    
    if (req.session.user) {
      const userId = req.session.user.id;
      const result = await pool.query(`
        SELECT ci.product_id, ci.quantity, p.name, p.price_usd, p.price_rub, p.image_url
        FROM cart_items ci
        JOIN products p ON ci.product_id = p.id
        WHERE ci.user_id = $1
      `, [userId]);
      
      cartItems = result.rows;
    } else if (req.session.cart && req.session.cart.length > 0) {
      const productIds = req.session.cart.map(item => item.product_id);
      
      if (productIds.length > 0) {
        const result = await pool.query(`
          SELECT id as product_id, name, price_usd, price_rub, image_url
          FROM products
          WHERE id = ANY($1)
        `, [productIds]);
        
        cartItems = result.rows.map(product => {
          const sessionItem = req.session.cart.find(item => item.product_id === product.product_id);
          return {
            ...product,
            quantity: sessionItem ? sessionItem.quantity : 1
          };
        });
      }
    }
    
    const userSettings = req.session.user ?
      await getUserSettings(req.session.user.id) :
      { language: res.locals.locale || 'en', currency: 'USD' };
    
    const currency = userSettings.currency || 'USD';
    if (currency === 'USD') {
      total = cartItems.reduce((sum, item) => {
        const price = item.discounted_price_usd || item.price_usd;
        return sum + (price * item.quantity);
      }, 0);
    } else {
      total = cartItems.reduce((sum, item) => {
        const price = item.discounted_price_rub || item.price_rub;
        return sum + (price * item.quantity);
      }, 0);
    }
    
    res.render('cart', {
      title: 'WinKey - Shopping Cart',
      activePage: 'cart',
      pageName: 'cart',
      cartItems,
      total,
      currency,
      user: req.session.user,
      settings: userSettings
    });
  } catch (err) {
    console.error('Error rendering cart page:', err);
    res.status(500).render('error', {
      title: 'Error',
      message: 'Could not load cart page',
      user: req.session.user
    });
  }
});

// Route: /order-success
router.get('/order-success', async (req, res) => {
  try {
    const orderId = req.query.id;
    
    const userSettings = req.session.user ?
      await getUserSettings(req.session.user.id) :
      { language: res.locals.locale || 'en', currency: 'USD' };
    
    res.render('order-success', {
      title: 'WinKey - Order Success',
      activePage: 'order-success',
      pageName: 'order-success',
      user: req.session.user || {},
      orderId: orderId,
      settings: userSettings
    });
  } catch (err) {
    console.error('Error rendering order success page:', err);
    res.status(500).render('error', {
      title: 'Error',
      message: 'Could not load order success page',
      user: req.session.user
    });
  }
});

module.exports = { router }; 