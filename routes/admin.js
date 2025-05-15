const express = require('express');
const path = require('path');
const fs = require('fs');
const { pool } = require('../db');
const { isAuthenticated, isAdmin } = require('../middleware/auth');

let upload;
let syncProductsFromDigiseller;
let updateDigisellerProduct;
let createDigisellerProduct;

const router = express.Router();

router.use(isAuthenticated, isAdmin);

const setDependencies = (multerUpload, digisellerSyncer, digisellerUpdater, digisellerCreator) => {
  upload = multerUpload;
  syncProductsFromDigiseller = digisellerSyncer;
  updateDigisellerProduct = digisellerUpdater;
  createDigisellerProduct = digisellerCreator;
  
  setupRoutes();
};

function setupRoutes() {
  // Route: GET /admin (Dashboard)
  router.get('/', async (req, res) => {
    try {
      const userCountResult = await pool.query('SELECT COUNT(*) FROM users');
      const productCountResult = await pool.query('SELECT COUNT(*) FROM products');
      const purchaseCountResult = await pool.query('SELECT COUNT(*) FROM purchases WHERE status = \'completed\'');

      const userCount = parseInt(userCountResult.rows[0].count, 10);
      const productCount = parseInt(productCountResult.rows[0].count, 10);
      const purchaseCount = parseInt(purchaseCountResult.rows[0].count, 10);

      res.render('admin/dashboard', {
        userCount: userCount,
        productCount: productCount,
        purchaseCount: purchaseCount,
        activePage: 'admin',
        user: req.session.user
      });
    } catch (err) {
      console.error('Error fetching admin dashboard stats:', err);
      res.render('admin/dashboard', {
        userCount: 0,
        productCount: 0,
        purchaseCount: 0,
        activePage: 'admin',
        user: req.session.user,
        error: 'Could not load dashboard statistics.'
      });
    }
  });

  // Route: GET /admin/products
  router.get('/products', async (req, res) => {
    try {
      if (!pool) throw new Error('Database pool not initialized');
      const result = await pool.query('SELECT * FROM products ORDER BY id');
      res.render('admin/products', {
        products: result.rows,
        activePage: 'admin/products',
        user: req.session.user
      });
    } catch (err) {
      console.error('Error fetching admin products:', err);
      res.status(500).render('admin/products', { 
          products: [], 
          activePage: 'admin/products', 
          user: req.session.user, 
          error: 'Server error fetching products.'
      });
    }
  });

  // Route: POST /admin/products (Create)
  router.post('/products', upload.single('image_file'), async (req, res) => {
    try {
      if (!pool) throw new Error('Database pool not initialized');
      console.log('Creating new product:', req.body);
      console.log('Uploaded file:', req.file);

      const {
        name, name_ru, description, description_ru,
        price_usd, price_rub, discounted_price_usd, discounted_price_rub,
        category
      } = req.body;

      const image_url = req.file ? `/uploads/${req.file.filename}` : null;
      const calculatedPriceRub = price_rub || Math.round(parseFloat(price_usd) * 90);
      const calculatedDiscountedRub = discounted_price_rub ||
        (discounted_price_usd ? Math.round(parseFloat(discounted_price_usd) * 90) : null);

      // First create the product in Digiseller
      const productData = {
        name,
        name_ru: name_ru || name,
        description,
        description_ru: description_ru || description,
        price_usd: parseFloat(price_usd),
        price_rub: calculatedPriceRub,
        discounted_price_usd: discounted_price_usd ? parseFloat(discounted_price_usd) : null,
        discounted_price_rub: calculatedDiscountedRub,
        category
      };

      // Check if we have the Digiseller integration function
      if (typeof createDigisellerProduct === 'function') {
        console.log('Creating product in Digiseller...');
        const digiResult = await createDigisellerProduct(productData);
        
        if (digiResult.success) {
          console.log(`Product created in Digiseller with ID: ${digiResult.productId}`);
          
          // Store with the Digiseller ID
          await pool.query(
            `INSERT INTO products
              (id, name, name_ru, description, description_ru,
               price_usd, price_rub, discounted_price_usd, discounted_price_rub,
               category, image_url)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
            [
              digiResult.productId,
              name, name_ru || name,
              description, description_ru || description,
              parseFloat(price_usd), calculatedPriceRub,
              discounted_price_usd ? parseFloat(discounted_price_usd) : null, calculatedDiscountedRub,
              category, image_url || `https://graph.digiseller.ru/img.ashx?id_d=${digiResult.productId}&maxlength=400`
            ]
          );
        } else {
          console.error('Failed to create product in Digiseller:', digiResult.error);
          return res.status(500).redirect('/admin/products?error=digisellerCreateFailed&message=' + encodeURIComponent(digiResult.error));
        }
      } else {
        console.log('Digiseller integration not available, creating product in local DB only');
        // Fallback to just creating in the local database
        await pool.query(
          `INSERT INTO products
            (name, name_ru, description, description_ru,
             price_usd, price_rub, discounted_price_usd, discounted_price_rub,
             category, image_url)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
          [
            name, name_ru || name,
            description, description_ru || description,
            parseFloat(price_usd), calculatedPriceRub,
            discounted_price_usd ? parseFloat(discounted_price_usd) : null, calculatedDiscountedRub,
            category, image_url
          ]
        );
      }

      console.log('Product created successfully');
      res.redirect('/admin/products');
    } catch (err) {
      console.error('Error creating product:', err);
      res.status(500).redirect('/admin/products?error=createFailed'); 
    }
  });

  // Route: POST /admin/products/:id (Update)
  router.post('/products/:id', upload.single('image_file'), async (req, res) => {
    const id = req.params.id;
    let originalProduct;
    try {
      if (!pool) throw new Error('Database pool not initialized');
      if (!updateDigisellerProduct) throw new Error('updateDigisellerProduct not initialized');

      console.log('Updating product ID:', id, 'Data:', req.body);
      console.log('Uploaded file (update):', req.file);

      const originalResult = await pool.query('SELECT image_url FROM products WHERE id = $1', [id]);
      if (originalResult.rows.length === 0) {
        console.error('Product not found for update:', id);
        return res.status(404).send('Product not found');
      }
      originalProduct = originalResult.rows[0];

      const {
        name, name_ru, description, description_ru,
        price_usd, price_rub, discounted_price_usd, discounted_price_rub,
        category
      } = req.body;

      let image_url = originalProduct.image_url;
      if (req.file) {
        image_url = `/uploads/${req.file.filename}`;
        // const oldImagePath = path.join(__dirname, '..', originalProduct.image_url); // Adjust path
        // if (originalProduct.image_url && originalProduct.image_url.startsWith('/uploads/') && fs.existsSync(oldImagePath)) {
        //   try { fs.unlinkSync(oldImagePath); } catch (e) { console.error("Error deleting old image:", e); }
        // }
      }

      const calculatedPriceRub = price_rub || Math.round(parseFloat(price_usd) * 90);
      const calculatedDiscountedRub = discounted_price_rub ||
        (discounted_price_usd ? Math.round(parseFloat(discounted_price_usd) * 90) : null);

      // --- Local DB Update ---
      await pool.query(
        `UPDATE products SET
          name = $1, name_ru = $2,
          description = $3, description_ru = $4,
          price_usd = $5, price_rub = $6,
          discounted_price_usd = $7, discounted_price_rub = $8,
          category = $9, image_url = $10
        WHERE id = $11`,
        [
          name, name_ru || name,
          description, description_ru || description,
          parseFloat(price_usd), calculatedPriceRub,
          discounted_price_usd ? parseFloat(discounted_price_usd) : null, calculatedDiscountedRub,
          category, image_url,
          id
        ]
      );
      console.log('Local product updated successfully');

      // --- Digiseller Update ---
      try {
        const productDataForApi = {
          name: name,
          name_ru: name_ru || name,
          description: description,
          description_ru: description_ru || description,
          price_usd: parseFloat(price_usd),
          price_rub: calculatedPriceRub,
          discounted_price_usd: discounted_price_usd ? parseFloat(discounted_price_usd) : null,
          discounted_price_rub: calculatedDiscountedRub,
          category: category,
          image_url: image_url
        };

        console.log(`Syncing all product data for ${id} to Digiseller...`);
        const digisellerUpdateSuccess = await updateDigisellerProduct(id, productDataForApi);
        
        if (digisellerUpdateSuccess) {
          console.log(`Successfully synced product ${id} to Digiseller.`);
        } else {
          console.log(`Failed to sync product ${id} to Digiseller (API Error).`);
        }
      } catch (digisellerError) {
        console.error(`Failed to sync full product update to Digiseller for product ${id}: ${digisellerError.message}`);
        console.log('Local DB is updated, but Digiseller sync failed.');
        return res.status(500).redirect(`/admin/products?error=updateFailed&digisellerError=true`);
      }

      res.redirect('/admin/products');
    } catch (err) {
      console.error('Error updating product:', err);
      res.status(500).redirect(`/admin/products?error=updateFailed`);
    }
  });

  // Route: POST /admin/products/:id/delete
  router.post('/products/:id/delete', async (req, res) => {
    try {
      if (!pool) throw new Error('Database pool not initialized');
      const id = req.params.id;
      console.log('Deleting product ID:', id);

      const checkResult = await pool.query('SELECT id FROM products WHERE id = $1', [id]);
      if (checkResult.rows.length === 0) {
        console.error('Product not found for deletion');
        return res.status(404).redirect('/admin/products?error=notFound');
      }

      await pool.query('DELETE FROM cart_items WHERE product_id = $1', [id]);

      await pool.query('DELETE FROM cart_items WHERE product_id = $1', [id]);
      await pool.query('DELETE FROM order_items WHERE product_id = $1', [id]);
      await pool.query('DELETE FROM purchases WHERE product_id = $1', [id]);
      await pool.query('DELETE FROM products WHERE id = $1', [id]);

      console.log('Product deleted successfully from local DB');
      res.redirect('/admin/products');
    } catch (err) {
      console.error('Error deleting product:', err);
      res.status(500).redirect('/admin/products?error=deleteFailed');
    }
  });

  // Route: GET /admin/users
  router.get('/users', async (req, res) => {
    try {
      if (!pool) throw new Error('Database pool not initialized');
      const result = await pool.query('SELECT * FROM users ORDER BY id');
      res.render('admin/users', {
        users: result.rows,
        activePage: 'admin/users',
        user: req.session.user
      });
    } catch (err) {
      console.error('Error fetching admin users:', err);
      res.status(500).render('admin/users', { 
          users: [], 
          activePage: 'admin/users', 
          user: req.session.user, 
          error: 'Server error fetching users.' 
      });
    }
  });

  // Route: POST /admin/users/:id/toggle-ban
  router.post('/users/:id/toggle-ban', async (req, res) => {
    try {
      if (!pool) throw new Error('Database pool not initialized');
      const id = req.params.id;
      await pool.query('UPDATE users SET is_banned = NOT is_banned WHERE id = $1', [id]);
      res.redirect('/admin/users');
    } catch (err) {
      console.error('Error toggling user ban status:', err);
      res.status(500).redirect('/admin/users?error=banToggleFailed');
    }
  });

  // Route: POST /admin/users/:id/toggle-admin
  router.post('/users/:id/toggle-admin', async (req, res) => {
    try {
      if (!pool) throw new Error('Database pool not initialized');
      const id = req.params.id;
      const result = await pool.query('SELECT role FROM users WHERE id = $1', [id]);
      if (result.rows.length === 0) {
          return res.status(404).redirect('/admin/users?error=notFound');
      }
      const currentRole = result.rows[0].role;
      
      const newRole = currentRole === 'admin' ? 'user' : 'admin';
      await pool.query('UPDATE users SET role = $1 WHERE id = $2', [newRole, id]);
      res.redirect('/admin/users');
    } catch (err) {
      console.error('Error toggling user admin status:', err);
      res.status(500).redirect('/admin/users?error=adminToggleFailed');
    }
  });

  // Route: GET /admin/purchases
  router.get('/purchases', async (req, res) => {
    try {
      if (!pool) throw new Error('Database pool not initialized');
      
      // Query to check if purchase_items table exists
      const tableCheck = await pool.query(`
        SELECT EXISTS (
          SELECT FROM information_schema.tables 
          WHERE table_name = 'purchase_items'
        )
      `);
      
      let result;
      
      if (tableCheck.rows[0].exists) {
        // Get purchases with item count
        result = await pool.query(`
          WITH purchase_item_counts AS (
            SELECT purchase_id, COUNT(*) as item_count
            FROM purchase_items
            GROUP BY purchase_id
          )
          SELECT p.id, u.username as user, 
                 CASE 
                    WHEN pic.item_count > 1 THEN 'Multiple Items (' || pic.item_count || ')'
                    WHEN pr.name IS NOT NULL THEN pr.name
                    ELSE 'Unknown Product'
                 END as product,
                 p.total_price_usd as price_usd, 
                 p.total_price_rub as price_rub, 
                 p.purchase_date,
                 pic.item_count
          FROM purchases p
          JOIN users u ON p.user_id = u.id
          LEFT JOIN purchase_item_counts pic ON p.id = pic.purchase_id
          LEFT JOIN products pr ON p.product_id = pr.id
          WHERE p.status = 'completed'
          ORDER BY p.purchase_date DESC
        `);
      } else {
        // Fallback to old query if purchase_items table doesn't exist
        result = await pool.query(`
          SELECT p.id, u.username as user, pr.name as product, 
                 p.price_usd, p.price_rub, p.purchase_date,
                 1 as item_count
          FROM purchases p
          JOIN users u ON p.user_id = u.id
          LEFT JOIN products pr ON p.product_id = pr.id
          WHERE p.status = 'completed'
          ORDER BY p.purchase_date DESC
        `);
      }
      
      res.render('admin/purchases', {
        purchases: result.rows,
        activePage: 'admin/purchases',
        user: req.session.user
      });
    } catch (err) {
      console.error('Error fetching admin purchases:', err);
      res.status(500).render('admin/purchases', { 
          purchases: [], 
          activePage: 'admin/purchases', 
          user: req.session.user, 
          error: 'Server error fetching purchases.' 
      });
    }
  });

  // Route: GET /admin/purchases/:id
  router.get('/purchases/:id', async (req, res) => {
    try {
      if (!pool) throw new Error('Database pool not initialized');
      const purchaseId = req.params.id;
      
      // Fetch the basic purchase information
      const purchaseResult = await pool.query(`
        SELECT p.*,
               u.username, u.email,
               pr.name, pr.name_ru, pr.image_url,
               pr.description, pr.description_ru,
               pr.category
        FROM purchases p
        JOIN users u ON p.user_id = u.id
        LEFT JOIN products pr ON p.product_id = pr.id
        WHERE p.id = $1
      `, [purchaseId]);

      if (purchaseResult.rows.length === 0) {
        console.error('Purchase not found');
        return res.status(404).redirect('/admin/purchases?error=notFound');
      }

      const purchase = purchaseResult.rows[0];
      
      // Check if purchase_items table exists
      const tableCheck = await pool.query(`
        SELECT EXISTS (
          SELECT FROM information_schema.tables 
          WHERE table_name = 'purchase_items'
        )
      `);
      
      let purchaseItems = [];
      
      if (tableCheck.rows[0].exists) {
        // Fetch all items in this purchase if it's a multi-item purchase
        const itemsResult = await pool.query(`
          SELECT pi.*, pr.name, pr.name_ru, pr.image_url, pr.category
          FROM purchase_items pi
          JOIN products pr ON pi.product_id = pr.id
          WHERE pi.purchase_id = $1
        `, [purchaseId]);
        
        purchaseItems = itemsResult.rows;
      }
      
      res.render('admin/purchase-details', {
        purchase,
        purchaseItems,
        activePage: 'admin/purchases',
        user: req.session.user
      });
    } catch (err) {
      console.error('Error getting purchase details:', err);
      res.status(500).redirect('/admin/purchases?error=viewFailed');
    }
  });

  // Route: POST /admin/purchases/:id/delete
  router.post('/purchases/:id/delete', async (req, res) => {
    try {
      if (!pool) throw new Error('Database pool not initialized');
      const purchaseId = req.params.id;
      const checkResult = await pool.query('SELECT id FROM purchases WHERE id = $1', [purchaseId]);

      if (checkResult.rows.length === 0) {
        console.error('Purchase not found for deletion');
        return res.status(404).redirect('/admin/purchases?error=notFound');
      }

      await pool.query('DELETE FROM purchases WHERE id = $1', [purchaseId]);
      console.log('Purchase deleted successfully');
      res.redirect('/admin/purchases');
    } catch (err) {
      console.error('Error deleting purchase:', err);
      res.status(500).redirect('/admin/purchases?error=deleteFailed');
    }
  });

  // Route: GET /admin/sync-products
  router.get('/sync-products', async (req, res) => {
    try {
      if (!syncProductsFromDigiseller) throw new Error('syncProductsFromDigiseller not initialized');
      const count = await syncProductsFromDigiseller();
      res.redirect('/admin/products?syncStatus=success&count=' + count);
    } catch (err) {
      console.error('Error syncing products via admin route:', err);
      res.status(500).redirect('/admin/products?syncStatus=error&message=' + encodeURIComponent(err.message));
    }
  });
}

module.exports = { router, setDependencies }; 