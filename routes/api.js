const express = require('express');
const { pool } = require('../db');
const crypto = require('crypto');

let isAuthenticated;
let isAdmin;

const router = express.Router();

const setDependencies = (authMiddleware, adminMiddleware) => {
  isAuthenticated = authMiddleware;
  isAdmin = adminMiddleware;
  
  setupRoutes();
};

function setupRoutes() {
  // Route: GET /api/auth/check
  router.get('/auth/check', (req, res) => {
    if (req.session.user) {
      res.json({
        isAuthenticated: true,
        user: {
          id: req.session.user.id,
          username: req.session.user.username,
          email: req.session.user.email,
          role: req.session.user.role
        }
      });
    } else {
      res.json({ isAuthenticated: false });
    }
  });

  // Route: GET /api/check-auth (Legacy/Compatibility)
  router.get('/check-auth', (req, res) => {
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

  // Route: GET /api/products/:id (For admin edit form population)
  router.get('/products/:id', (req, res, next) => {
      if (!isAuthenticated || !isAdmin) {
          return res.status(500).json({ error: 'Server auth middleware not configured.'});
      }
      isAuthenticated(req, res, (err) => {
          if (err) return next(err);
          isAdmin(req, res, next);
      });
    },
    async (req, res) => {
    try {
      const productId = req.params.id;
      const result = await pool.query('SELECT * FROM products WHERE id = $1', [productId]);

      if (result.rows.length === 0) {
        return res.status(404).json({ error: 'Product not found' });
      }

      res.json(result.rows[0]);
    } catch (err) {
      console.error('Error fetching product details for API:', err);
      res.status(500).json({ error: 'Server error fetching product details' });
    }
  });

  // Route: POST /api/checkout
  router.post('/checkout', async (req, res) => {
    try {
      let cartItems = [];
      const userId = req.session.user ? req.session.user.id : null;
      const userEmail = req.body.email || (req.session.user ? req.session.user.email : null);
      const guestIp = req.headers['x-forwarded-for'] || req.connection.remoteAddress || null;
      const guestUserAgent = req.headers['user-agent'] || null;
      const registered = !!userId;
      
      if (!userEmail) {
        return res.status(400).json({ error: 'Email is required for checkout' });
      }
      
      if (userId) {
        const cartResult = await pool.query(`
          SELECT ci.product_id, ci.quantity, p.id, p.name, p.price_usd, p.price_rub
          FROM cart_items ci
          JOIN products p ON ci.product_id = p.id
          WHERE ci.user_id = $1
        `, [userId]);
        
        cartItems = cartResult.rows;
      } else if (req.session.cart && req.session.cart.length > 0) {
        const productIds = req.session.cart.map(item => item.product_id);
        const productsResult = await pool.query(`
          SELECT id, name, price_usd, price_rub
          FROM products 
          WHERE id = ANY($1)
        `, [productIds]);
        
        cartItems = req.session.cart.map(item => {
          const product = productsResult.rows.find(p => p.id === item.product_id);
          return {
            product_id: item.product_id,
            quantity: item.quantity,
            id: product.id,
            name: product.name,
            price_usd: product.price_usd,
            price_rub: product.price_rub
          };
        });
      }
      
      if (cartItems.length === 0) {
        return res.status(400).json({ error: 'No items in cart' });
      }
      
      const currency = req.body.currency || 'USD';
      let totalAmount = 0;
      let digisellerCurrency = currency === 'USD' ? 'USD' : 'RUB';
      
      totalAmount = cartItems.reduce((sum, item) => {
        return sum + (currency === 'USD' ? item.price_usd : item.price_rub) * item.quantity;
      }, 0);
      
      const description = cartItems.map(item => `${item.name} x${item.quantity}`).join(', ');
      
      const tableCheck = await pool.query(`
        SELECT EXISTS (
          SELECT FROM information_schema.tables 
          WHERE table_name = 'purchase_items'
        )
      `);
      
      if (!tableCheck.rows[0].exists) {
        console.log("Creating purchase_items table...");
        await pool.query(`
          CREATE TABLE purchase_items (
            id SERIAL PRIMARY KEY,
            purchase_id INTEGER NOT NULL REFERENCES purchases(id) ON DELETE CASCADE,
            product_id INTEGER NOT NULL,
            quantity INTEGER DEFAULT 1 NOT NULL,
            price_usd DECIMAL(12, 2) NOT NULL,
            price_rub DECIMAL(12, 2) NOT NULL
          )
        `);
        console.log("purchase_items table created successfully.");
      }
      
      let purchaseResult;
      if (userId) {
        purchaseResult = await pool.query(`
          INSERT INTO purchases (user_id, status, total_price_usd, total_price_rub, purchase_date, price_usd, price_rub, product_id, registered)
          VALUES ($1, $2, $3, $4, NOW(), $5, $6, $7, TRUE)
          RETURNING id
        `, [
          userId, 
          'pending',
          currency === 'USD' ? totalAmount : cartItems.reduce((sum, item) => sum + item.price_usd * item.quantity, 0),
          currency === 'RUB' ? totalAmount : cartItems.reduce((sum, item) => sum + item.price_rub * item.quantity, 0),
          cartItems.length === 1 ? cartItems[0].price_usd : null,
          cartItems.length === 1 ? cartItems[0].price_rub : null,
          cartItems.length === 1 ? cartItems[0].product_id : null
        ]);
      } else {
        purchaseResult = await pool.query(`
          INSERT INTO purchases (user_id, status, total_price_usd, total_price_rub, purchase_date, price_usd, price_rub, product_id, guest_email, guest_ip, guest_user_agent, registered)
          VALUES (NULL, $1, $2, $3, NOW(), $4, $5, $6, $7, $8, $9, FALSE)
          RETURNING id
        `, [
          'pending',
          currency === 'USD' ? totalAmount : cartItems.reduce((sum, item) => sum + item.price_usd * item.quantity, 0),
          currency === 'RUB' ? totalAmount : cartItems.reduce((sum, item) => sum + item.price_rub * item.quantity, 0),
          cartItems.length === 1 ? cartItems[0].price_usd : null,
          cartItems.length === 1 ? cartItems[0].price_rub : null,
          cartItems.length === 1 ? cartItems[0].product_id : null,
          userEmail,
          guestIp,
          guestUserAgent
        ]);
      }
      
      const purchaseId = purchaseResult.rows[0].id;
      
      for (const item of cartItems) {
        await pool.query(`
          INSERT INTO purchase_items (purchase_id, product_id, quantity, price_usd, price_rub)
          VALUES ($1, $2, $3, $4, $5)
        `, [
          purchaseId,
          item.product_id,
          item.quantity,
          item.price_usd,
          item.price_rub
        ]);
      }
      
      const sellerId = process.env.DIGISELLER_SELLER_ID || '750992';
      const returnUrl = `${req.protocol}://${req.get('host')}/order-success?id=${purchaseId}`;
      const failUrl = `${req.protocol}://${req.get('host')}/checkout`;
      
      let typecurr = currency === 'USD' ? 'USD' : (currency === 'EUR' ? 'EUR' : 'RUB');
      
      let paymentUrl = '';
      
      if (cartItems.length === 1) {
        const singleParams = new URLSearchParams();
        singleParams.append('id_d', cartItems[0].product_id.toString());
        singleParams.append('seller_id', sellerId);
        singleParams.append('typecurr', typecurr);
        singleParams.append('email', userEmail);
        singleParams.append('lang', req.body.lang || 'ru-RU');
        singleParams.append('failpage', failUrl);
        singleParams.append('success_url', returnUrl);
        singleParams.append('cf1', purchaseId.toString());
        singleParams.append('unit_cnt', cartItems[0].quantity.toString());
        
        paymentUrl = `https://oplata.info/asp2/pay.asp?${singleParams.toString()}`;
      } else {
        let cart_uid = '';
        let digisellerError = false;

        try {
          for (let i = 0; i < cartItems.length; i++) {
            const item = cartItems[i];
            const itemParams = new URLSearchParams();
            itemParams.append('product_id', item.product_id.toString());
            itemParams.append('product_cnt', item.quantity.toString());
            itemParams.append('typecurr', typecurr);
            itemParams.append('email', userEmail);
            itemParams.append('lang', req.body.lang || 'ru-RU');
            if (cart_uid) {
              itemParams.append('cart_uid', cart_uid);
            }

            console.log(`Adding item to Digiseller cart (or creating): ${item.name}, Qty: ${item.quantity}, Params: ${itemParams.toString()}`);

            const addItemResponse = await fetch('https://shop.digiseller.ru/xml/shop_cart_add.asp', {
              method: 'POST',
              headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                'Accept': 'application/json'
              },
              body: itemParams.toString()
            });

            if (!addItemResponse.ok) {
              console.error(`Failed to add item to Digiseller cart (HTTP ${addItemResponse.status}): ${item.name}`);
              digisellerError = true;
              break;
            }

            const addItemData = await addItemResponse.json();
            console.log('Digiseller cart add response:', addItemData);

            if (addItemData.cart_err !== '0') {
              console.error(`Digiseller cart API error (cart_err: ${addItemData.cart_err}): ${item.name}`);
              digisellerError = true;
              break;
            }

            if (!cart_uid && addItemData.cart_uid) {
              cart_uid = addItemData.cart_uid;
              console.log(`Captured Digiseller cart_uid: ${cart_uid}`);
            }
          }

          if (!digisellerError && cart_uid) {
            const cartParams = new URLSearchParams();
            cartParams.append('cart_uid', cart_uid);
            cartParams.append('typecurr', typecurr);
            cartParams.append('email', userEmail);
            cartParams.append('lang', req.body.lang || 'ru-RU');
            cartParams.append('failpage', failUrl);
            cartParams.append('success_url', returnUrl);
            cartParams.append('cf1', purchaseId.toString());

            paymentUrl = `https://oplata.info/asp2/pay_cart.asp?${cartParams.toString()}`;
            console.log('Constructed Digiseller cart payment URL:', paymentUrl);
          } else {
            console.warn('Digiseller cart creation failed or cart_uid not obtained. Falling back (if applicable).');
            if (!paymentUrl && cartItems.length > 0) {
                const singleParams = new URLSearchParams();
                singleParams.append('id_d', cartItems[0].product_id.toString());
                singleParams.append('seller_id', sellerId);
                singleParams.append('typecurr', typecurr);
                singleParams.append('email', userEmail);
                singleParams.append('lang', req.body.lang || 'ru-RU');
                singleParams.append('failpage', failUrl);
                singleParams.append('success_url', returnUrl);
                singleParams.append('cf1', purchaseId.toString());
                singleParams.append('unit_cnt', cartItems[0].quantity.toString());
                paymentUrl = `https://oplata.info/asp2/pay.asp?${singleParams.toString()}`;
                console.log('Fallback to single item payment URL:', paymentUrl);
            }
          }

        } catch (cartError) {
          console.error('Unexpected error during Digiseller cart interaction:', cartError);
          if (!paymentUrl && cartItems.length > 0) {
              const singleParams = new URLSearchParams();
              singleParams.append('id_d', cartItems[0].product_id.toString());
              singleParams.append('seller_id', sellerId);
              singleParams.append('typecurr', typecurr);
              singleParams.append('email', userEmail);
              singleParams.append('lang', req.body.lang || 'ru-RU');
              singleParams.append('failpage', failUrl);
              singleParams.append('success_url', returnUrl);
              singleParams.append('cf1', purchaseId.toString());
              singleParams.append('unit_cnt', cartItems[0].quantity.toString());
              paymentUrl = `https://oplata.info/asp2/pay.asp?${singleParams.toString()}`;
              console.log('Fallback (catch block) to single item payment URL:', paymentUrl);
           }
        }
      }

      if (!paymentUrl) {
          console.error("Failed to generate payment URL.");
          return res.status(500).json({ error: 'Failed to generate payment URL' });
      }

      if (userId) {
        await pool.query('DELETE FROM cart_items WHERE user_id = $1', [userId]);
      } else {
        req.session.cart = [];
      }
      
      res.json({
        success: true,
        redirect_url: paymentUrl
      });
      
    } catch (err) {
      console.error('Checkout error:', err);
      res.status(500).json({ error: 'Error processing checkout' });
    }
  });
  
  // Route: GET /api/payment/callback
  router.get('/payment/callback', async (req, res) => {
    try {
      const {
        id_d,
        id_o,
        email,
        summ,
        currency,
        status,
        cf1
      } = req.query;
      
      if (status === 'success' && cf1) {
        const purchaseId = cf1;
        
        await pool.query(`
          UPDATE purchases
          SET status = 'completed', digiseller_order_id = $1, completion_date = NOW()
          WHERE id = $2
        `, [id_o, purchaseId]);
        
        console.log(`Payment success for purchase ${purchaseId}, Digiseller order ${id_o}`);
        
        if (req.session.user) {
          const userCheck = await pool.query('SELECT user_id FROM purchases WHERE id = $1', [purchaseId]);
          
          if (!userCheck.rows[0].user_id) {
            await pool.query('UPDATE purchases SET user_id = $1 WHERE id = $2', [
              req.session.user.id, 
              purchaseId
            ]);
          }
        }
        
        return res.redirect(`/order-success?id=${purchaseId}`);
      } else if (status === 'fail') {
        console.log(`Payment failed for Digiseller product ${id_d}, order ${id_o}`);
        return res.redirect('/checkout?error=payment_failed');
      }
      
      res.redirect('/');
    } catch (err) {
      console.error('Error processing payment callback:', err);
      res.status(500).json({ error: 'Error processing payment callback' });
    }
  });
  
  // Route: POST /api/digiseller/callback - Server-to-server payment notification from Digiseller
  router.post('/digiseller/callback', async (req, res) => {
    try {
      const {
        invoice_id,
        amount,
        currency,
        status,
        signature
      } = req.body;
      
      // Log the callback for debugging
      console.log('Digiseller callback received:', req.body);
      
      // Verify signature to ensure callback is authentic
      const sellerId = process.env.DIGISELLER_SELLER_ID || '750992';
      const secretKey = process.env.DIGISELLER_API_KEY || 'your-secret-key';
      
      // According to Digiseller API, signature is hmac-sha256 of string generated from alphabetically sorted params
      // Format: amount:10.00;currency:USD;invoice_id:12345;status:paid;
      const signatureString = `amount:${amount};currency:${currency};invoice_id:${invoice_id};status:${status};`;
      const calculatedSignature = crypto.createHmac('sha256', secretKey)
        .update(signatureString)
        .digest('hex');
      
      if (calculatedSignature !== signature) {
        console.error('Invalid signature in Digiseller callback');
        return res.status(400).send('Invalid signature');
      }
      
      // Find the purchase by invoice_id (digiseller_order_id)
      const purchaseResult = await pool.query(
        'SELECT id FROM purchases WHERE digiseller_order_id = $1',
        [invoice_id]
      );
      
      if (purchaseResult.rows.length === 0) {
        console.error(`Purchase not found for Digiseller invoice ${invoice_id}`);
        return res.status(404).send('Purchase not found');
      }
      
      const purchaseId = purchaseResult.rows[0].id;
      
      // Update purchase status based on Digiseller status
      let purchaseStatus;
      switch(status) {
        case 'paid':
          purchaseStatus = 'completed';
          break;
        case 'wait':
          purchaseStatus = 'canceled';
          break;
        case 'canceled':
        case 'refunded':
          purchaseStatus = 'canceled';
          break;
        case 'error':
          purchaseStatus = 'failed';
          break;
        default:
          purchaseStatus = 'canceled';
      }
      
      await pool.query(`
        UPDATE purchases
        SET status = $1, completion_date = $2
        WHERE id = $3
      `, [
        purchaseStatus, 
        purchaseStatus === 'completed' ? 'NOW()' : null,
        purchaseId
      ]);
      
      console.log(`Updated purchase ${purchaseId} status to ${purchaseStatus} from Digiseller callback`);
      
      // Return success to Digiseller
      res.status(200).send('OK');
    } catch (err) {
      console.error('Error processing Digiseller server callback:', err);
      res.status(500).send('Error processing callback');
    }
  });
  
  // Route: GET /api/payment-status/:orderId - Check payment status for client
  router.get('/payment-status/:orderId', async (req, res) => {
    try {
      const orderId = req.params.orderId;
      
      // First check in our database
      const purchaseResult = await pool.query(
        'SELECT id, status, digiseller_order_id FROM purchases WHERE id = $1',
        [orderId]
      );
      
      if (purchaseResult.rows.length === 0) {
        return res.status(404).json({ error: 'Order not found' });
      }
      
      const purchase = purchaseResult.rows[0];
      
      if (purchase.status === 'completed') {
        return res.json({ status: 'paid', order_id: purchase.id });
      } else if (purchase.status === 'canceled' || purchase.status === 'failed') {
        return res.json({ status: 'canceled', order_id: purchase.id });
      }
      
      // If status still pending, try to check with Digiseller API
      if (purchase.digiseller_order_id) {
        try {
          const sellerId = process.env.DIGISELLER_SELLER_ID || '750992';
          const secretKey = process.env.DIGISELLER_API_KEY || 'your-secret-key';
          
          // Prepare parameters for Digiseller API call
          const amount = '0.00'; // We don't need actual amount for status check
          const invoiceId = purchase.digiseller_order_id;
          const signatureString = `amount:${amount};currency:USD;invoice_id:${invoiceId};seller_id:${sellerId};`;
          const signature = crypto.createHmac('sha256', secretKey)
            .update(signatureString)
            .digest('hex');
          
          // Make request to Digiseller to check payment status
          const response = await fetch(`https://digiseller.market/callback/api?invoice_id=${invoiceId}&amount=${amount}&currency=USD&seller_id=${sellerId}&signature=${signature}`, {
            method: 'GET',
            headers: {
              'Accept': 'application/json'
            }
          });
          
          if (response.ok) {
            const data = await response.json();
            
            if (data.status === 'paid') {
              // Update our database with the confirmed status
              await pool.query(`
                UPDATE purchases
                SET status = 'completed', completion_date = NOW()
                WHERE id = $1
              `, [orderId]);
              
              return res.json({ status: 'paid', order_id: purchase.id });
            } else {
              // Any status other than paid is considered canceled (including 'wait')
              // Update our database with the canceled status
              await pool.query(`
                UPDATE purchases
                SET status = 'canceled'
                WHERE id = $1
              `, [orderId]);
              
              return res.json({ status: 'canceled', order_id: purchase.id });
            }
          } else {
            console.error('Error response from Digiseller API:', await response.text());
            // Mark as canceled if we can't verify with Digiseller
            await pool.query(`
              UPDATE purchases
              SET status = 'canceled'
              WHERE id = $1
            `, [orderId]);
            return res.json({ status: 'canceled', order_id: purchase.id });
          }
        } catch (apiError) {
          console.error('Error calling Digiseller API:', apiError);
          // Mark as canceled if API call fails
          await pool.query(`
            UPDATE purchases
            SET status = 'canceled'
            WHERE id = $1
          `, [orderId]);
          return res.json({ status: 'canceled', order_id: purchase.id });
        }
      }
      
      // No Digiseller order ID yet, mark as canceled
      await pool.query(`
        UPDATE purchases
        SET status = 'canceled'
        WHERE id = $1
      `, [orderId]);
      return res.json({ status: 'canceled', order_id: purchase.id });
      
    } catch (err) {
      console.error('Error checking payment status:', err);
      res.status(500).json({ error: 'Error checking payment status' });
    }
  });

  // Route: GET /api/orders/:id
  router.get('/orders/:id', async (req, res) => {
    try {
      const orderId = req.params.id;
      
      const result = await pool.query(`
        SELECT p.*, 
               COALESCE(p.total_price_usd, 0) as total_price_usd,
               COALESCE(p.total_price_rub, 0) as total_price_rub
        FROM purchases p
        WHERE p.id = $1
      `, [orderId]);
      
      if (result.rows.length === 0) {
        return res.status(404).json({ error: 'Order not found' });
      }
      
      const order = result.rows[0];
      const userIsAdmin = req.session.user && req.session.user.role === 'admin';
      const orderBelongsToUser = req.session.user && order.user_id === req.session.user.id;
      
      if (!userIsAdmin && !orderBelongsToUser && order.user_id !== null) {
        return res.status(403).json({ error: 'Not authorized to view this order' });
      }
      
      const itemsResult = await pool.query(`
        SELECT pi.*, p.name, p.image_url
        FROM purchase_items pi
        JOIN products p ON pi.product_id = p.id
        WHERE pi.purchase_id = $1
      `, [orderId]);
      
      const orderDetails = {
        ...order,
        items: itemsResult.rows
      };
      
      res.json(orderDetails);
    } catch (err) {
      console.error('Error fetching order details:', err);
      res.status(500).json({ error: 'Error fetching order details' });
    }
  });

  // Route: POST /api/cart - Add item to cart
  router.post('/cart', async (req, res) => {
    try {
      const { productId, quantity } = req.body;
      
      if (!productId || !quantity) {
        return res.status(400).json({ success: false, error: 'Product ID and quantity are required' });
      }
      
      const productResult = await pool.query('SELECT * FROM products WHERE id = $1', [productId]);
      if (productResult.rows.length === 0) {
        return res.status(404).json({ success: false, error: 'Product not found' });
      }
      
      if (req.session.user) {
        const userId = req.session.user.id;
        
        const cartCheck = await pool.query(
          'SELECT * FROM cart_items WHERE user_id = $1 AND product_id = $2',
          [userId, productId]
        );
        
        if (cartCheck.rows.length > 0) {
          const newQuantity = cartCheck.rows[0].quantity + quantity;
          await pool.query(
            'UPDATE cart_items SET quantity = $1 WHERE user_id = $2 AND product_id = $3',
            [newQuantity, userId, productId]
          );
        } else {
          await pool.query(
            'INSERT INTO cart_items (user_id, product_id, quantity) VALUES ($1, $2, $3)',
            [userId, productId, quantity]
          );
        }
      } else {
        if (!req.session.cart) {
          req.session.cart = [];
        }
        
        const existingItem = req.session.cart.find(item => item.product_id === parseInt(productId));
        
        if (existingItem) {
          existingItem.quantity += parseInt(quantity);
        } else {
          req.session.cart.push({
            product_id: parseInt(productId),
            quantity: parseInt(quantity)
          });
        }
      }
      
      res.json({ success: true });
    } catch (err) {
      console.error('Error adding item to cart:', err);
      res.status(500).json({ success: false, error: 'Server error adding item to cart' });
    }
  });
  
  // Route: GET /api/cart - Get cart items
  router.get('/cart', async (req, res) => {
    try {
      let cartItems = [];
      
      if (req.session.user) {
        const userId = req.session.user.id;
        const cartResult = await pool.query(`
          SELECT ci.product_id, ci.quantity, p.name, p.price_usd, p.price_rub, 
                 p.discounted_price_usd, p.discounted_price_rub, p.image_url
          FROM cart_items ci
          JOIN products p ON ci.product_id = p.id
          WHERE ci.user_id = $1
        `, [userId]);
        
        cartItems = cartResult.rows;
      } else if (req.session.cart && req.session.cart.length > 0) {
        const productIds = req.session.cart.map(item => item.product_id);
        
        if (productIds.length > 0) {
          const productsResult = await pool.query(`
            SELECT id AS product_id, name, price_usd, price_rub, 
                   discounted_price_usd, discounted_price_rub, image_url
            FROM products
            WHERE id = ANY($1)
          `, [productIds]);
          
          cartItems = productsResult.rows.map(product => {
            const sessionItem = req.session.cart.find(item => item.product_id === product.product_id);
            return {
              ...product,
              quantity: sessionItem ? sessionItem.quantity : 1
            };
          });
        }
      }
      
      res.json({ success: true, cart: cartItems });
    } catch (err) {
      console.error('Error getting cart items:', err);
      res.status(500).json({ success: false, error: 'Server error getting cart items' });
    }
  });
  
  // Route: PUT /api/cart/:productId - Update cart item quantity
  router.put('/cart/:productId', async (req, res) => {
    try {
      const productId = req.params.productId;
      const { quantity } = req.body;
      
      if (!quantity || quantity < 1) {
        return res.status(400).json({ success: false, error: 'Valid quantity is required' });
      }
      
      if (req.session.user) {
        const userId = req.session.user.id;
        await pool.query(
          'UPDATE cart_items SET quantity = $1 WHERE user_id = $2 AND product_id = $3',
          [quantity, userId, productId]
        );
      } else if (req.session.cart) {
        const itemIndex = req.session.cart.findIndex(item => item.product_id === parseInt(productId));
        if (itemIndex !== -1) {
          req.session.cart[itemIndex].quantity = parseInt(quantity);
        }
      }
      
      res.json({ success: true });
    } catch (err) {
      console.error('Error updating cart item:', err);
      res.status(500).json({ success: false, error: 'Server error updating cart item' });
    }
  });
  
  // Route: DELETE /api/cart/:productId - Remove item from cart
  router.delete('/cart/:productId', async (req, res) => {
    try {
      const productId = req.params.productId;
      
      if (req.session.user) {
        const userId = req.session.user.id;
        await pool.query(
          'DELETE FROM cart_items WHERE user_id = $1 AND product_id = $2',
          [userId, productId]
        );
      } else if (req.session.cart) {
        req.session.cart = req.session.cart.filter(item => item.product_id !== parseInt(productId));
      }
      
      res.json({ success: true });
    } catch (err) {
      console.error('Error removing item from cart:', err);
      res.status(500).json({ success: false, error: 'Server error removing item from cart' });
    }
  });
  
  // Route: DELETE /api/cart - Clear cart
  router.delete('/cart', async (req, res) => {
    try {
      if (req.session.user) {
        const userId = req.session.user.id;
        await pool.query('DELETE FROM cart_items WHERE user_id = $1', [userId]);
      } else {
        req.session.cart = [];
      }
      
      res.json({ success: true });
    } catch (err) {
      console.error('Error clearing cart:', err);
      res.status(500).json({ success: false, error: 'Error clearing cart' });
    }
  });

  // Route: GET /api/user/settings - Get user settings
  router.get('/user/settings', async (req, res) => {
    try {
      let settings = {
        language: res.locals.locale || 'en',
        currency: 'USD'
      };
      
      if (req.session.user) {
        const userId = req.session.user.id;
        const result = await pool.query(
          'SELECT language, currency FROM user_settings WHERE user_id = $1',
          [userId]
        );
        
        if (result.rows.length > 0) {
          settings = result.rows[0];
        }
      }
      
      res.json(settings);
    } catch (err) {
      console.error('Error getting user settings:', err);
      res.status(500).json({ error: 'Error retrieving user settings' });
    }
  });
  
  // Route: POST /api/user/settings - Save user settings
  router.post('/user/settings', async (req, res) => {
    try {
      const { language, currency } = req.body;
      
      if (!language || !currency) {
        return res.status(400).json({ error: 'Language and currency are required' });
      }
      
      if (req.session.user) {
        const userId = req.session.user.id;
        
        const checkResult = await pool.query(
          'SELECT 1 FROM user_settings WHERE user_id = $1',
          [userId]
        );
        
        if (checkResult.rows.length > 0) {
          await pool.query(
            'UPDATE user_settings SET language = $1, currency = $2 WHERE user_id = $3',
            [language, currency, userId]
          );
        } else {
          await pool.query(
            'INSERT INTO user_settings (user_id, language, currency) VALUES ($1, $2, $3)',
            [userId, language, currency]
          );
        }
      }
      
      res.cookie('locale', language, {
        maxAge: 30 * 24 * 60 * 60 * 1000 // 30 days
      });
      
      res.json({ success: true });
    } catch (err) {
      console.error('Error saving user settings:', err);
      res.status(500).json({ error: 'Error saving user settings' });
    }
  });
}

module.exports = { router, setDependencies }; 