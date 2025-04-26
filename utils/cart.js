let pool;

const setDbPool = (dbPool) => {
    pool = dbPool;
};

async function moveCartItemsToDatabase(req) {
  if (!pool) {
    console.warn('(Cart Util) DB Pool not set, cannot move cart items.');
    return;
  }
  try {
    if (!req.session.user || !req.session.cart || req.session.cart.length === 0) {
      return;
    }

    console.log('(Cart Util) Moving guest cart items to database for user:', req.session.user.username);
    const userId = req.session.user.id;

    const movePromises = req.session.cart.map(async (item) => {
        const checkResult = await pool.query(
            'SELECT quantity FROM cart_items WHERE user_id = $1 AND product_id = $2',
            [userId, item.product_id]
        );

        if (checkResult.rows.length > 0) {
            const newQuantity = checkResult.rows[0].quantity + item.quantity;
            await pool.query(
                'UPDATE cart_items SET quantity = $1 WHERE user_id = $2 AND product_id = $3',
                [newQuantity, userId, item.product_id]
            );
        } else {
            await pool.query(
                'INSERT INTO cart_items (user_id, product_id, quantity) VALUES ($1, $2, $3)',
                [userId, item.product_id, item.quantity]
            );
        }
    });

    await Promise.all(movePromises);

    req.session.cart = [];
    console.log('(Cart Util) Guest cart items moved successfully and session cart cleared.');

  } catch (err) {
    console.error('(Cart Util) Error moving cart items to database:', err);
  }
}

module.exports = {
    setDbPool,
    moveCartItemsToDatabase
}; 