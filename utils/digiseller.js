require('dotenv').config(); // Ensure env variables are loaded
const https = require('https');
const crypto = require('crypto');

let pool;

// Digiseller Constants & Config
const DIGISELLER_API_URL = "https://api.digiseller.com/api/";
const SELLER_ID = process.env.DIGISELLER_SELLER_ID || "750992";
const DIGISELLER_API_KEY = process.env.DIGISELLER_API_KEY;

let digisellerToken = { token: null, expires: 0 };

// --- Helper Functions (Internal to this module mostly) ---

async function getDigisellerToken() {
  if (digisellerToken.token && digisellerToken.expires > Date.now()) {
    console.log("(Digiseller Util) Using cached Digiseller token.");
    return digisellerToken.token;
  }

  if (!DIGISELLER_API_KEY) {
    throw new Error("(Digiseller Util) Digiseller API Key is not configured.");
  }

  console.log("(Digiseller Util) Fetching new Digiseller API token...");
  const timestamp = Math.floor(Date.now() / 1000);
  const signStr = DIGISELLER_API_KEY + timestamp;
  const sign = crypto.createHash('sha256').update(signStr).digest('hex');

  const postData = JSON.stringify({
    seller_id: parseInt(SELLER_ID, 10),
    timestamp: timestamp,
    sign: sign
  });

  const options = {
    hostname: 'api.digiseller.com',
    port: 443,
    path: '/api/apilogin',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      'Content-Length': Buffer.byteLength(postData)
    }
  };

  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          if (res.statusCode === 200) {
            const response = JSON.parse(data);
            if (response.retval === 0 && response.token) {
              digisellerToken = {
                token: response.token,
                expires: new Date(response.valid_thru).getTime() - (5 * 60 * 1000) 
              };
              console.log("(Digiseller Util) Successfully obtained new Digiseller token.");
              resolve(digisellerToken.token);
            } else {
              const errorMsg = response.desc || `retval: ${response.retval}`;
              console.error("(Digiseller Util) Error getting token:", errorMsg);
              reject(new Error(`(Digiseller Util) Failed to get token: ${errorMsg}`));
            }
          } else {
             console.error(`(Digiseller Util) Token API error: Status ${res.statusCode}, Body: ${data}`);
             reject(new Error(`(Digiseller Util) Token API request failed: ${res.statusCode}`));
          }
        } catch (e) {
          console.error("(Digiseller Util) Error parsing token response:", e);
          reject(e);
        }
      });
    });
    req.on('error', (e) => {
      console.error("(Digiseller Util) Error requesting token:", e);
      reject(e);
    });
    req.write(postData);
    req.end();
  });
}

async function fetchProductsForLang(token, lang) {
    const requestData = JSON.stringify({
        id_seller: parseInt(SELLER_ID, 10),
        order_col: "name",
        order_dir: "asc",
        rows: 1000,
        page: 1,
        currency: "RUR",
        lang: lang,
        show_hidden: 0
    });

    const options = {
        hostname: 'api.digiseller.com',
        port: 443,
        path: `/api/seller-goods?token=${token}`,
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Accept': 'application/json',
            'Content-Length': Buffer.byteLength(requestData)
        }
    };

    console.log(`(Digiseller Util) Fetching products - Lang: ${lang}`);
    return new Promise((resolve, reject) => {
         const req = https.request(options, (res) => {
            let data = '';
            res.on('data', (chunk) => { data += chunk; });
            res.on('end', () => {
                try {
                    if (res.statusCode !== 200) {
                        console.error(`(Digiseller Util) (${lang}) fetch error: Status ${res.statusCode}, Body: ${data}`);
                        if (res.statusCode === 401 || res.statusCode === 403) {
                           digisellerToken = { token: null, expires: 0 };
                        }
                        return reject(new Error(`(Digiseller Util) (${lang}) API request failed: ${res.statusCode}`));
                    }
                    const jsonData = JSON.parse(data);
                    if (jsonData.retval !== 0) {
                        const errorMsg = jsonData.retdesc || `Code ${jsonData.retval}`;
                        console.error(`(Digiseller Util) (${lang}) API error: ${errorMsg}`);
                        return reject(new Error(`(Digiseller Util) (${lang}) API error: ${errorMsg}`));
                    }
                    resolve(jsonData.rows || []);
                } catch (err) {
                    console.error(`(Digiseller Util) Error parsing/processing (${lang}) data:`, err);
                    reject(err);
                }
            });
        });
        req.on('error', (err) => {
            console.error(`(Digiseller Util) HTTPS request error (${lang}):`, err);
            reject(err);
        });
        req.write(requestData);
        req.end();
    });
}

// --- Exported Functions --- 

// Function to fully update product details on Digiseller
async function updateDigisellerProduct(productId, productData) {
  let token;
  try {
    token = await getDigisellerToken();
  } catch (err) {
    console.error(`(Digiseller Util) Failed to get token for update (Product ID: ${productId}):`, err.message);
    return false; 
  }

  console.log(`(Digiseller Util) Attempting update for ${productId}`);

  const payload = {
    enabled: true, 
    name: [
      { locale: "ru-RU", value: productData.name_ru || productData.name },
      { locale: "en-US", value: productData.name }
    ],
    description: [
      { locale: "ru-RU", value: productData.description_ru || productData.description },
      { locale: "en-US", value: productData.description }
    ],
    prices: {
      price: parseFloat(productData.price_rub),
      currency: "RUB",
      unit_quantity: 1, 
      unit_name: "Item" 
    },
    comission_partner: 15,
  };
  
  const productTypes = ["uniquefixed", "uniqueunfixed", "software", "ebook", "arbitrary"];
  
  let updateSuccess = false;
  let successType = null;
  
  for (const productType of productTypes) {
    const options = {
      hostname: 'api.digiseller.com',
      port: 443,
      path: `/api/product/edit/${productType}/${productId}?token=${token}`, 
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'Content-Length': Buffer.byteLength(JSON.stringify(payload))
      }
    };

    try {
      const success = await new Promise((resolve, reject) => {
        const req = https.request(options, (res) => {
          let data = '';
          res.on('data', (chunk) => { data += chunk; });
          res.on('end', () => {
            try {
              if (res.statusCode !== 200) {
                console.error(`(Digiseller Util) Update API error with type "${productType}": Status ${res.statusCode}, Body: ${data}`);
                if (res.statusCode === 401 || res.statusCode === 403) {
                  digisellerToken = { token: null, expires: 0 };
                }
                resolve(false);
                return;
              }
              const jsonData = JSON.parse(data);
              if (jsonData.retval === 0) {
                console.log(`(Digiseller Util) Update successful for product ${productId} with type "${productType}".`);
                resolve(true);
              } else {
                const errorDesc = jsonData.retdesc || JSON.stringify(jsonData.errors || jsonData);
                console.error(`(Digiseller Util) Update failed for product ${productId} with type "${productType}": ${errorDesc}`);
                resolve(false);
              }
            } catch (parseErr) {
              console.error(`(Digiseller Util) Error parsing update response for ${productId}:`, parseErr);
              console.log(`Raw response: ${data}`);
              resolve(false);
            }
          });
        });
        req.on('error', (err) => {
          console.error(`(Digiseller Util) HTTPS request error during update for ${productId}:`, err);
          resolve(false);
        });
        req.write(JSON.stringify(payload));
        req.end();
      });

      if (success) {
        updateSuccess = true;
        successType = productType;
        break;
      }
    } catch (err) {
      console.error(`(Digiseller Util) Error trying product type "${productType}" for ${productId}:`, err);
      continue;
    }
  }
  
  if (!updateSuccess) {
    console.error(`(Digiseller Util) Failed to update product ${productId} after trying all product types.`);
    return false;
  }
  
  try {
    const priceUpdateSuccess = await updateProductPrice(token, productId, productData.price_rub, productData.price_usd);
    if (priceUpdateSuccess) {
      console.log(`(Digiseller Util) Successfully updated price for product ${productId}.`);
    } else {
      console.log(`(Digiseller Util) Failed to update price for product ${productId}.`);
    }
  } catch (priceErr) {
    console.error(`(Digiseller Util) Error updating price for product ${productId}:`, priceErr);
  }
  
  return true;
}

async function updateProductPrice(token, productId, priceRub, priceUsd) {
  if (!token) {
    try {
      token = await getDigisellerToken();
    } catch (err) {
      console.error(`(Digiseller Util) Failed to get token for price update (Product ID: ${productId}):`, err.message);
      return false;
    }
  }
  
  console.log(`(Digiseller Util) Attempting dual-currency price update for ${productId}: ${priceRub} RUB / ${priceUsd} USD`);
  
  let rubUpdateSuccess = false;
  let usdUpdateSuccess = false;
  
  try {
    const priceDataRub = [
      {
        "product_id": parseInt(productId, 10),
        "price": parseFloat(priceRub)
      }
    ];
    
    const optionsRub = {
      hostname: 'api.digiseller.com',
      port: 443,
      path: `/api/product/edit/prices?token=${token}&currency=RUB`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'Content-Length': Buffer.byteLength(JSON.stringify(priceDataRub))
      }
    };
    
    rubUpdateSuccess = await new Promise((resolve, reject) => {
      const req = https.request(optionsRub, (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          try {
            if (res.statusCode !== 200) {
              console.error(`(Digiseller Util) RUB price update API error: Status ${res.statusCode}, Body: ${data}`);
              if (res.statusCode === 401 || res.statusCode === 403) {
                digisellerToken = { token: null, expires: 0 };
              }
              resolve(false);
              return;
            }
            
            // According to docs, successful response is just a task ID
            const taskId = data.trim();
            console.log(`(Digiseller Util) RUB price update submitted, task ID: ${taskId}`);
            resolve(true);
          } catch (parseErr) {
            console.error(`(Digiseller Util) Error processing RUB price update response:`, parseErr);
            console.log(`Raw response: ${data}`);
            resolve(false);
          }
        });
      });
      
      req.on('error', (err) => {
        console.error(`(Digiseller Util) HTTPS request error during RUB price update:`, err);
        resolve(false);
      });
      
      req.write(JSON.stringify(priceDataRub));
      req.end();
    });
  } catch (err) {
    console.error(`(Digiseller Util) Error during RUB price update:`, err);
  }
  
  try {
    const priceDataUsd = [
      {
        "product_id": parseInt(productId, 10),
        "price": parseFloat(priceUsd)
      }
    ];
    
    const optionsUsd = {
      hostname: 'api.digiseller.com',
      port: 443,
      path: `/api/product/edit/prices?token=${token}&currency=USD`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'Content-Length': Buffer.byteLength(JSON.stringify(priceDataUsd))
      }
    };
    
    usdUpdateSuccess = await new Promise((resolve, reject) => {
      const req = https.request(optionsUsd, (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          try {
            if (res.statusCode !== 200) {
              console.error(`(Digiseller Util) USD price update API error: Status ${res.statusCode}, Body: ${data}`);
              if (res.statusCode === 401 || res.statusCode === 403) {
                digisellerToken = { token: null, expires: 0 };
              }
              resolve(false);
              return;
            }
            
            const taskId = data.trim();
            console.log(`(Digiseller Util) USD price update submitted, task ID: ${taskId}`);
            resolve(true);
          } catch (parseErr) {
            console.error(`(Digiseller Util) Error processing USD price update response:`, parseErr);
            console.log(`Raw response: ${data}`);
            resolve(false);
          }
        });
      });
      
      req.on('error', (err) => {
        console.error(`(Digiseller Util) HTTPS request error during USD price update:`, err);
        resolve(false);
      });
      
      req.write(JSON.stringify(priceDataUsd));
      req.end();
    });
  } catch (err) {
    console.error(`(Digiseller Util) Error during USD price update:`, err);
  }
  
  if (rubUpdateSuccess && usdUpdateSuccess) {
    console.log(`(Digiseller Util) Successfully updated both RUB and USD prices for product ${productId}`);
  } else if (rubUpdateSuccess) {
    console.log(`(Digiseller Util) Updated RUB price only for product ${productId}, USD update failed`);
  } else if (usdUpdateSuccess) {
    console.log(`(Digiseller Util) Updated USD price only for product ${productId}, RUB update failed`);
  } else {
    console.log(`(Digiseller Util) Failed to update both RUB and USD prices for product ${productId}`);
  }
  
  return rubUpdateSuccess || usdUpdateSuccess;
}

async function syncProductsFromDigiseller() {
  let token;
  try {
    token = await getDigisellerToken();
  } catch (err) {
    console.error("(Digiseller Util) Failed to get token, skipping sync:", err.message);
    return 0;
  }

  if (!pool) {
    console.error("(Digiseller Util) Database pool not available for sync. Skipping.");
    return 0;
  }

  try {
    console.log("(Digiseller Util) Starting product sync process...");
    const [productsEn, productsRu] = await Promise.all([
      fetchProductsForLang(token, 'en-US'),
      fetchProductsForLang(token, 'ru-RU')
    ]);

    const combinedProducts = {};
    for (const product of productsEn) {
        if (!product.id_goods) continue;
        combinedProducts[product.id_goods] = {
            id: parseInt(product.id_goods, 10),
            name: product.name_goods?.trim() || '',
            description: product.info_goods?.trim() || '',
            price_usd: parseFloat(product.price_usd) || 0,
            price_rub: parseFloat(product.price_rur) || parseFloat(product.price) || 0,
            category: 'Digiseller', 
            name_ru: product.name_goods?.trim() || '', 
            description_ru: product.info_goods?.trim() || '',
            discounted_price_usd: null,
            discounted_price_rub: null,
            image_url: `https://graph.digiseller.ru/img.ashx?id_d=${product.id_goods}&maxlength=400`
        };
        if (product.has_discount && product.sale_info && product.sale_info.sale_percent) {
            const discountPercent = parseFloat(product.sale_info.sale_percent);
            if (!isNaN(discountPercent) && discountPercent > 0) {
                combinedProducts[product.id_goods].discounted_price_usd = combinedProducts[product.id_goods].price_usd * (1 - discountPercent / 100);
                combinedProducts[product.id_goods].discounted_price_rub = combinedProducts[product.id_goods].price_rub * (1 - discountPercent / 100);
            }
        }
    }
    for (const product of productsRu) {
        if (!product.id_goods || !combinedProducts[product.id_goods]) continue;
         combinedProducts[product.id_goods].name_ru = product.name_goods?.trim() || combinedProducts[product.id_goods].name;
         combinedProducts[product.id_goods].description_ru = product.info_goods?.trim() || combinedProducts[product.id_goods].description;
    }

    const productList = Object.values(combinedProducts);
    console.log(`(Digiseller Util) Found ${productList.length} unique products.`);
    let processedCount = 0;
    let errorCount = 0;

    for (const product of productList) {
      try {
        const existingProduct = await pool.query('SELECT id FROM products WHERE id = $1', [product.id]);

        if (existingProduct.rows.length === 0) {
          await pool.query(`
            INSERT INTO products (
              id, name, name_ru, description, description_ru,
              price_usd, price_rub, discounted_price_usd, discounted_price_rub,
              image_url, category, created_at
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, CURRENT_TIMESTAMP)
            ON CONFLICT (id) DO NOTHING; -- Prevent errors if inserted concurrently
          `, [
            product.id, product.name, product.name_ru, product.description, product.description_ru,
            product.price_usd, product.price_rub, product.discounted_price_usd,
            product.discounted_price_rub, product.image_url, product.category
          ]);
          // console.log(`(Digiseller Util) Added product (ID ${product.id}): ${product.name}`);
        } else {
          await pool.query(`
            UPDATE products SET
              name = $1, name_ru = $2, description = $3, description_ru = $4,
              price_usd = $5, price_rub = $6,
              discounted_price_usd = $7, discounted_price_rub = $8,
              image_url = $9, category = $10
            WHERE id = $11
          `, [
            product.name, product.name_ru, product.description, product.description_ru,
            product.price_usd, product.price_rub, product.discounted_price_usd,
            product.discounted_price_rub, product.image_url, product.category,
            product.id
          ]);
          // console.log(`(Digiseller Util) Updated product (ID ${product.id}): ${product.name}`);
        }
        processedCount++;
      } catch (dbErr) {
        errorCount++;
        console.error(`(Digiseller Util) DB Error processing product ${product.id} (${product.name}):`, dbErr.message);
      }
    }
    console.log(`(Digiseller Util) Sync finished. Processed: ${processedCount}, DB Errors: ${errorCount}`);
    return processedCount;

  } catch (syncError) {
    console.error("(Digiseller Util) Error during product sync process:", syncError);
    return 0;
  }
}

const setDbPool = (dbPool) => {
    pool = dbPool;
    console.log("(Digiseller Util) Database pool set.");
};

// --- Initialization --- 

function startDigisellerSync(intervalHours = 1) {
    if (!DIGISELLER_API_KEY) {
        console.warn("(Digiseller Util) API Key missing, cannot start sync.");
        return;
    }
    if (!pool) {
        console.warn("(Digiseller Util) DB Pool missing, cannot start sync.");
        return;        
    }

    console.log("(Digiseller Util) Performing initial product sync...");
    syncProductsFromDigiseller()
        .then(count => console.log(`(Digiseller Util) Initial sync done. ${count} products processed.`))
        .catch(err => console.error('(Digiseller Util) Initial sync failed:', err.message));

    const intervalMillis = intervalHours * 60 * 60 * 1000;
    setInterval(() => {
        console.log("(Digiseller Util) Performing scheduled product sync...");
        syncProductsFromDigiseller()
            .then(count => console.log(`(Digiseller Util) Scheduled sync done. ${count} products processed.`))
            .catch(err => console.error('(Digiseller Util) Scheduled sync failed:', err.message));
    }, intervalMillis);
    console.log(`(Digiseller Util) Scheduled sync set for every ${intervalHours} hour(s).`);
}

async function createDigisellerProduct(productData) {
  let token;
  try {
    token = await getDigisellerToken();
  } catch (err) {
    console.error(`(Digiseller Util) Failed to get token for product creation:`, err.message);
    return { success: false, error: err.message };
  }

  console.log(`(Digiseller Util) Creating new product: ${productData.name}`);

  // Determine the product type based on category
  let productType = "uniquefixed"; // Default type
  if (productData.category.toLowerCase().includes("windows") || 
      productData.category.toLowerCase().includes("office") ||
      productData.category.toLowerCase().includes("microsoft")) {
    productType = "software";
  }

  // Set the appropriate category ID based on the product category
  let categoryId = 7074; // Default software category
  
  if (productData.category.toLowerCase().includes("windows")) {
    categoryId = 1019; // Windows category ID
  } else if (productData.category.toLowerCase().includes("office")) {
    categoryId = 1021; // Office category ID
  } else if (productData.category.toLowerCase().includes("microsoft 365")) {
    categoryId = 1021; // Use same Office category ID for Microsoft 365
  }

  const payload = {
    content_type: "text",
    name: [
      { locale: "ru-RU", value: productData.name_ru || productData.name },
      { locale: "en-US", value: productData.name }
    ],
    price: {
      price: parseFloat(productData.price_rub),
      currency: "RUB"
    },
    comission_partner: 15,
    categories: [
      { owner: 0, category_id: categoryId }
    ],
    description: [
      { locale: "ru-RU", value: productData.description_ru || productData.description },
      { locale: "en-US", value: productData.description }
    ],
    add_info: [
      { locale: "ru-RU", value: productData.description_ru || productData.description },
      { locale: "en-US", value: productData.description }
    ],
    bonus: {
      enabled: false,
      percent: 5
    },
    guarantee: {
      enabled: true,
      value: 5
    },
    address_required: false
  };

  const options = {
    hostname: 'api.digiseller.com',
    port: 443,
    path: `/api/product/create/${productType}?token=${token}`,
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      'Content-Length': Buffer.byteLength(JSON.stringify(payload))
    }
  };

  try {
    const result = await new Promise((resolve, reject) => {
      const req = https.request(options, (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          try {
            if (res.statusCode !== 200) {
              console.error(`(Digiseller Util) Create product API error: Status ${res.statusCode}, Body: ${data}`);
              resolve({ success: false, error: `API error: ${res.statusCode}` });
              return;
            }
            
            const jsonData = JSON.parse(data);
            if (jsonData.retval === 0 && jsonData.content && jsonData.content.product_id) {
              console.log(`(Digiseller Util) Product created successfully with ID: ${jsonData.content.product_id}`);
              resolve({ 
                success: true, 
                productId: jsonData.content.product_id 
              });
            } else {
              const errorDesc = jsonData.retdesc || JSON.stringify(jsonData.errors || jsonData);
              console.error(`(Digiseller Util) Product creation failed: ${errorDesc}`);
              resolve({ success: false, error: errorDesc });
            }
          } catch (parseErr) {
            console.error(`(Digiseller Util) Error parsing create product response:`, parseErr);
            console.log(`Raw response: ${data}`);
            resolve({ success: false, error: parseErr.message });
          }
        });
      });
      
      req.on('error', (err) => {
        console.error(`(Digiseller Util) HTTPS request error during product creation:`, err);
        resolve({ success: false, error: err.message });
      });
      
      req.write(JSON.stringify(payload));
      req.end();
    });

    // If product was created successfully, set USD price too
    if (result.success && productData.price_usd) {
      try {
        const priceUpdateSuccess = await updateProductPrice(token, result.productId, productData.price_rub, productData.price_usd);
        if (priceUpdateSuccess) {
          console.log(`(Digiseller Util) Successfully set USD price for new product ${result.productId}.`);
        } else {
          console.log(`(Digiseller Util) Failed to set USD price for new product ${result.productId}.`);
        }
      } catch (priceErr) {
        console.error(`(Digiseller Util) Error setting USD price for new product ${result.productId}:`, priceErr);
      }
    }

    return result;
  } catch (err) {
    console.error(`(Digiseller Util) Error creating product:`, err);
    return { success: false, error: err.message };
  }
}

async function getDigisellerCategories() {
  let token;
  try {
    token = await getDigisellerToken();
  } catch (err) {
    console.error(`(Digiseller Util) Failed to get token for category fetch:`, err.message);
    return { success: false, error: err.message };
  }

  const options = {
    hostname: 'api.digiseller.com',
    port: 443,
    path: '/api/dictionary/platforms/categories',
    method: 'GET',
    headers: {
      'Accept': 'application/json'
    }
  };

  try {
    const result = await new Promise((resolve, reject) => {
      const req = https.request(options, (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          try {
            if (res.statusCode !== 200) {
              console.error(`(Digiseller Util) Category fetch API error: Status ${res.statusCode}, Body: ${data}`);
              resolve({ success: false, error: `API error: ${res.statusCode}` });
              return;
            }
            
            const jsonData = JSON.parse(data);
            if (jsonData.retval === 0 && jsonData.content) {
              console.log(`(Digiseller Util) Categories fetched successfully`);
              resolve({ 
                success: true, 
                categories: jsonData.content
              });
            } else {
              const errorDesc = jsonData.retdesc || JSON.stringify(jsonData.errors || jsonData);
              console.error(`(Digiseller Util) Category fetch failed: ${errorDesc}`);
              resolve({ success: false, error: errorDesc });
            }
          } catch (parseErr) {
            console.error(`(Digiseller Util) Error parsing category response:`, parseErr);
            console.log(`Raw response: ${data}`);
            resolve({ success: false, error: parseErr.message });
          }
        });
      });
      
      req.on('error', (err) => {
        console.error(`(Digiseller Util) HTTPS request error during category fetch:`, err);
        resolve({ success: false, error: err.message });
      });
      
      req.end();
    });

    return result;
  } catch (err) {
    console.error(`(Digiseller Util) Error fetching categories:`, err);
    return { success: false, error: err.message };
  }
}

module.exports = {
    setDbPool,
    updateDigisellerProduct,
    syncProductsFromDigiseller,
    startDigisellerSync,
    createDigisellerProduct,
    getDigisellerCategories
}; 