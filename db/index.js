require('dotenv').config();
const { Pool } = require('pg');
const bcrypt = require('bcrypt');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL, 
  user: process.env.PG_USER,
  host: process.env.PG_HOST,
  database: process.env.PG_DATABASE,
  password: process.env.PG_PASSWORD, 
  port: parseInt(process.env.PG_PORT, 10),
  ssl: process.env.DATABASE_URL && process.env.DATABASE_URL.includes('ssl=true') ? { rejectUnauthorized: false } : false 
});

pool.on('connect', () => {
    console.log('(DB) Connected to PostgreSQL database.');
});

pool.on('error', (err) => {
    console.error('(DB) Unexpected error on idle client', err);
});

async function initDb() {
  console.log("(DB) Initializing database schema...");
  try {
    // --- Create user_sessions table --- 
    await pool.query(`
      CREATE TABLE IF NOT EXISTS "user_sessions" (
        "sid" varchar NOT NULL COLLATE "default",
        "sess" json NOT NULL,
        "expire" timestamp(6) NOT NULL
      ) WITH (OIDS=FALSE);
    `);
    const pkeyExists = await pool.query(`SELECT constraint_name FROM information_schema.table_constraints WHERE table_name = 'user_sessions' AND constraint_type = 'PRIMARY KEY';`);
    if (pkeyExists.rows.length === 0) {
      await pool.query(`ALTER TABLE "user_sessions" ADD CONSTRAINT "user_sessions_pkey" PRIMARY KEY ("sid") NOT DEFERRABLE INITIALLY IMMEDIATE;`);
    }
    const indexExists = await pool.query(`SELECT indexname FROM pg_indexes WHERE tablename = 'user_sessions' AND indexname = 'IDX_user_sessions_expire';`);
    if (indexExists.rows.length === 0) {
      await pool.query(`CREATE INDEX "IDX_user_sessions_expire" ON "user_sessions" ("expire");`);
    }
    console.log("(DB) Table 'user_sessions' checked/created.");

    // --- Create users table --- 
    await pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        username VARCHAR(50) UNIQUE NOT NULL,
        email VARCHAR(100) UNIQUE NOT NULL,
        password VARCHAR(100) NOT NULL,
        role VARCHAR(20) DEFAULT 'user' NOT NULL,
        is_banned BOOLEAN DEFAULT false NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    console.log("(DB) Table 'users' checked/created.");

    // --- Create/Update products table --- 
    const productsExistQuery = await pool.query(`SELECT EXISTS (SELECT FROM information_schema.tables WHERE table_name = 'products')`);
    const productsTableExists = productsExistQuery.rows[0].exists;
    
    if (productsTableExists) {
        console.log("(DB) Table 'products' exists, checking columns...");
        const productsColumns = await pool.query(`SELECT column_name FROM information_schema.columns WHERE table_name = 'products'`);
        const columns = productsColumns.rows.map(row => row.column_name);
        
        if (!columns.includes('name_ru')) { await pool.query(`ALTER TABLE products ADD COLUMN name_ru VARCHAR(255)`); console.log("    Added name_ru"); }
        if (!columns.includes('description_ru')) { await pool.query(`ALTER TABLE products ADD COLUMN description_ru TEXT`); console.log("    Added description_ru"); }
        if (!columns.includes('price_usd') && columns.includes('price')) { await pool.query(`ALTER TABLE products RENAME COLUMN price TO price_usd`); console.log("    Renamed price to price_usd"); }
        if (!columns.includes('price_rub')) { await pool.query(`ALTER TABLE products ADD COLUMN price_rub DECIMAL(12, 2)`); console.log("    Added price_rub"); }
        
        if (!columns.includes('updated_at')) { 
            await pool.query(`ALTER TABLE products ADD COLUMN updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP`); 
            console.log("    Added updated_at"); 
        }

        await pool.query(`UPDATE products SET price_rub = COALESCE(price_rub, price_usd * 90) WHERE price_usd IS NOT NULL`); 
        await pool.query(`ALTER TABLE products ALTER COLUMN price_rub SET NOT NULL`);

        if (!columns.includes('discounted_price_usd') && columns.includes('discounted_price')) { await pool.query(`ALTER TABLE products RENAME COLUMN discounted_price TO discounted_price_usd`); console.log("    Renamed discounted_price to discounted_price_usd"); }
        if (!columns.includes('discounted_price_rub')) { await pool.query(`ALTER TABLE products ADD COLUMN discounted_price_rub DECIMAL(12, 2)`); console.log("    Added discounted_price_rub"); }
        
        await pool.query(`ALTER TABLE products ALTER COLUMN price_usd TYPE DECIMAL(12, 2)`);
        await pool.query(`ALTER TABLE products ALTER COLUMN discounted_price_usd TYPE DECIMAL(12, 2)`);
        await pool.query(`ALTER TABLE products ALTER COLUMN price_rub TYPE DECIMAL(12, 2)`);
        await pool.query(`ALTER TABLE products ALTER COLUMN discounted_price_rub TYPE DECIMAL(12, 2)`);

        await pool.query(`ALTER TABLE products ALTER COLUMN price_usd SET NOT NULL`);
        
        console.log("(DB) Columns for 'products' checked/updated.");
    } else {
        console.log("(DB) Table 'products' does not exist, creating...");
        await pool.query(`
            CREATE TABLE products (
                id INTEGER PRIMARY KEY, -- Use ID from Digiseller
                name VARCHAR(255) NOT NULL,
                name_ru VARCHAR(255),
                description TEXT,
                description_ru TEXT,
                price_usd DECIMAL(12, 2) NOT NULL,
                price_rub DECIMAL(12, 2) NOT NULL,
                discounted_price_usd DECIMAL(12, 2),
                discounted_price_rub DECIMAL(12, 2),
                category VARCHAR(100),
                image_url VARCHAR(512),
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP -- Add updated_at
            )
        `);
        console.log("(DB) Table 'products' created.");
    }
    
    // --- Create cart_items table --- 
    await pool.query(`
      CREATE TABLE IF NOT EXISTS cart_items (
        id SERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
        quantity INTEGER DEFAULT 1 NOT NULL CHECK (quantity > 0),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE (user_id, product_id) -- Prevent duplicate product entries per user
      )
    `);
    console.log("(DB) Table 'cart_items' checked/created.");

    // --- Create orders table --- 
    await pool.query(`
      CREATE TABLE IF NOT EXISTS orders (
        id SERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE SET NULL, -- Keep order history if user deleted?
        total_amount_usd DECIMAL(12, 2) NOT NULL,
        total_amount_rub DECIMAL(12, 2) NOT NULL,
        status VARCHAR(50) DEFAULT 'completed' NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    console.log("(DB) Table 'orders' checked/created.");

    // --- Create order_items table --- 
    await pool.query(`
      CREATE TABLE IF NOT EXISTS order_items (
        id SERIAL PRIMARY KEY,
        order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
        product_id INTEGER NOT NULL, -- No FK to allow keeping history if product deleted
        quantity INTEGER DEFAULT 1 NOT NULL,
        price_usd DECIMAL(12, 2) NOT NULL,
        price_rub DECIMAL(12, 2) NOT NULL,
        product_name VARCHAR(255) -- Store name at time of order
      )
    `);
    console.log("(DB) Table 'order_items' checked/created.");

    // --- Create purchases table) --- 
    await pool.query(`
      CREATE TABLE IF NOT EXISTS purchases (
        id SERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        product_id INTEGER NOT NULL, -- No FK to allow keeping history
        price_usd DECIMAL(12, 2),
        price_rub DECIMAL(12, 2),
        purchase_date TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        product_name VARCHAR(255), -- Store name at time of purchase
        status VARCHAR(20) DEFAULT 'pending', -- Status column
        digiseller_order_id VARCHAR(50), -- For tracking in digiseller
        total_price_usd DECIMAL(12, 2),
        total_price_rub DECIMAL(12, 2),
        completion_date TIMESTAMP
      )
    `);
    console.log("(DB) Table 'purchases' checked/created.");

    // --- Create purchase_items table --- 
    await pool.query(`
      CREATE TABLE IF NOT EXISTS purchase_items (
        id SERIAL PRIMARY KEY,
        purchase_id INTEGER NOT NULL REFERENCES purchases(id) ON DELETE CASCADE,
        product_id INTEGER NOT NULL,
        quantity INTEGER DEFAULT 1 NOT NULL,
        price_usd DECIMAL(12, 2) NOT NULL,
        price_rub DECIMAL(12, 2) NOT NULL
      )
    `);
    console.log("(DB) Table 'purchase_items' checked/created.");

    const purchasesColumnsQuery = await pool.query(`SELECT column_name FROM information_schema.columns WHERE table_name = 'purchases'`);
    const purchasesColumns = purchasesColumnsQuery.rows.map(row => row.column_name);
    
    if (!purchasesColumns.includes('status')) { 
      await pool.query(`ALTER TABLE purchases ADD COLUMN status VARCHAR(20) DEFAULT 'pending'`); 
      console.log("    Added status column to purchases table"); 
    }
    if (!purchasesColumns.includes('digiseller_order_id')) { 
      await pool.query(`ALTER TABLE purchases ADD COLUMN digiseller_order_id VARCHAR(50)`); 
      console.log("    Added digiseller_order_id column to purchases table"); 
    }
    if (!purchasesColumns.includes('total_price_usd')) { 
      await pool.query(`ALTER TABLE purchases ADD COLUMN total_price_usd DECIMAL(12, 2)`); 
      console.log("    Added total_price_usd column to purchases table"); 
    }
    if (!purchasesColumns.includes('total_price_rub')) { 
      await pool.query(`ALTER TABLE purchases ADD COLUMN total_price_rub DECIMAL(12, 2)`); 
      console.log("    Added total_price_rub column to purchases table"); 
    }
    if (!purchasesColumns.includes('completion_date')) { 
      await pool.query(`ALTER TABLE purchases ADD COLUMN completion_date TIMESTAMP`); 
      console.log("    Added completion_date column to purchases table"); 
    }
    if (!purchasesColumns.includes('guest_email')) { 
      await pool.query(`ALTER TABLE purchases ADD COLUMN guest_email TEXT`); 
      console.log("    Added guest_email column to purchases table"); 
    }
    if (!purchasesColumns.includes('guest_ip')) { 
      await pool.query(`ALTER TABLE purchases ADD COLUMN guest_ip TEXT`); 
      console.log("    Added guest_ip column to purchases table"); 
    }
    if (!purchasesColumns.includes('guest_user_agent')) { 
      await pool.query(`ALTER TABLE purchases ADD COLUMN guest_user_agent TEXT`); 
      console.log("    Added guest_user_agent column to purchases table"); 
    }
    if (!purchasesColumns.includes('registered')) { 
      await pool.query(`ALTER TABLE purchases ADD COLUMN registered BOOLEAN DEFAULT TRUE`); 
      console.log("    Added registered column to purchases table"); 
    }

    // --- Create user_settings table --- 
    await pool.query(`
      CREATE TABLE IF NOT EXISTS user_settings (
        user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        language VARCHAR(10) DEFAULT 'en' NOT NULL,
        currency VARCHAR(10) DEFAULT 'USD' NOT NULL
      )
    `);
    console.log("(DB) Table 'user_settings' checked/created.");
    
    // Create trigger to update updated_at timestamp 
    try {
        await pool.query(`
            CREATE OR REPLACE FUNCTION update_modified_column()
            RETURNS TRIGGER AS $$
            BEGIN
               -- Check if the column exists in the table before trying to update it
               IF EXISTS (
                   SELECT 1 FROM information_schema.columns 
                   WHERE table_name = TG_TABLE_NAME 
                   AND column_name = 'updated_at'
               ) THEN
                   NEW.updated_at = now();
               END IF;
               RETURN NEW;
            END;
            $$ language 'plpgsql';
        `);
        
        await pool.query(`
            DROP TRIGGER IF EXISTS update_products_modtime ON products;
            CREATE TRIGGER update_products_modtime BEFORE UPDATE ON products FOR EACH ROW EXECUTE PROCEDURE update_modified_column();
        `);
        console.log("(DB) Trigger 'update_products_modtime' checked/created.");
    } catch (triggerError) {
        console.error("(DB) Error creating update_modified_column trigger:", triggerError.message);
        console.log("(DB) Continuing without updated_at trigger.");
    }

    // --- Create default admin user --- 
    const adminExists = await pool.query('SELECT id FROM users WHERE username = $1', [process.env.ADMIN_USERNAME || 'admin']);
    if (adminExists.rows.length === 0) {
      const adminUsername = process.env.ADMIN_USERNAME || 'admin';
      const adminEmail = process.env.ADMIN_EMAIL || 'admin@example.com';
      const adminPassword = process.env.ADMIN_PASSWORD || ''; // Use env var!
      const hashedPassword = await bcrypt.hash(adminPassword, 10);
      await pool.query(
        'INSERT INTO users (username, email, password, role) VALUES ($1, $2, $3, $4)',
        [adminUsername, adminEmail, hashedPassword, 'admin']
      );
      console.log(`(DB) Default admin user '${adminUsername}' created.`);
    } else {
      console.log("(DB) Default admin user already exists.");
    }

    // Убираем NOT NULL с user_id для поддержки гостевых покупок
    const userIdNullable = await pool.query(`SELECT is_nullable FROM information_schema.columns WHERE table_name = 'purchases' AND column_name = 'user_id'`);
    if (userIdNullable.rows.length && userIdNullable.rows[0].is_nullable !== 'YES') {
      await pool.query(`ALTER TABLE purchases ALTER COLUMN user_id DROP NOT NULL`);
      console.log("    Made user_id nullable in purchases table");
    }

    console.log('(DB) Database initialization checks complete.');
    
  } catch (err) {
    console.error('(DB) Error initializing database:', err);
    throw err;
  }
}

module.exports = {
    pool,
    initDb
}; 