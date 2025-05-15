let pool;

const setDbPool = (dbPool) => {
    pool = dbPool;
};

async function getUserSettings(userId) {
  if (!pool) {
    console.warn('(Settings Util) DB Pool not set, returning default settings.');
    return { language: 'en', currency: 'USD' };
  }
  try {
    const result = await pool.query('SELECT * FROM user_settings WHERE user_id = $1', [userId]);
    if (result.rows.length === 0) {
      return { language: 'en', currency: 'USD' };
    }
    return result.rows[0];
  } catch (err) {
    console.error('(Settings Util) Error getting user settings for user:', userId, err);
    return { language: 'en', currency: 'USD' };
  }
}

module.exports = {
    setDbPool,
    getUserSettings
}; 