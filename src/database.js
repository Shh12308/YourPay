const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const USE_POSTGRES = Boolean(process.env.DATABASE_URL);
const IS_PRODUCTION = process.env.NODE_ENV === "production";

const dataDir = path.join(__dirname, "..", "data");
const databaseFile = path.join(dataDir, "database.json");

const emptyDatabase = {
  merchants: [],
  apiKeys: [],
  customers: [],
  payments: []
};

let pool = null;
let initialized = false;
let defaultMerchantId = null;

const database = loadLocalDatabase();

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function loadLocalDatabase() {
  if (USE_POSTGRES) {
    return clone(emptyDatabase);
  }

  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }

  if (!fs.existsSync(databaseFile)) {
    fs.writeFileSync(
      databaseFile,
      JSON.stringify(emptyDatabase, null, 2),
      "utf8"
    );
  }

  const raw = fs.readFileSync(databaseFile, "utf8");

  if (!raw.trim()) {
    return clone(emptyDatabase);
  }

  const data = JSON.parse(raw);

  return {
    merchants: Array.isArray(data.merchants) ? data.merchants : [],
    apiKeys: Array.isArray(data.apiKeys) ? data.apiKeys : [],
    customers: Array.isArray(data.customers) ? data.customers : [],
    payments: Array.isArray(data.payments) ? data.payments : []
  };
}

function saveLocalDatabase() {
  if (USE_POSTGRES) {
    throw new Error("Local JSON storage is disabled.");
  }

  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }

  const temporaryFile = databaseFile + ".tmp";

  fs.writeFileSync(
    temporaryFile,
    JSON.stringify(database, null, 2),
    "utf8"
  );

  fs.renameSync(temporaryFile, databaseFile);
}

function makeId(prefix) {
  return prefix + "_" + crypto.randomBytes(16).toString("hex");
}

function normalizeMerchant(row) {
  if (!row) {
    return null;
  }

  return {
    id: row.id,
    name: row.name,
    createdAt: row.created_at || row.createdAt
  };
}

function normalizeApiKey(row) {
  if (!row) {
    return null;
  }

  return {
    id: row.id,
    merchantId: row.merchant_id || row.merchantId,
    keyHash: row.key_hash || row.keyHash,
    keyPrefix: row.key_prefix || row.keyPrefix,
    createdAt: row.created_at || row.createdAt,
    revokedAt: row.revoked_at || row.revokedAt || null
  };
}

function normalizeCustomer(row) {
  if (!row) {
    return null;
  }

  return {
    id: row.id,
    merchantId: row.merchant_id || row.merchantId,
    email: row.email,
    name: row.name || null,
    createdAt: row.created_at || row.createdAt
  };
}

function normalizePayment(row) {
  if (!row) {
    return null;
  }

  return {
    id: row.id,
    merchantId: row.merchant_id || row.merchantId,
    amount: Number(row.amount),
    currency: row.currency,
    status: row.status,
    customerId: row.customer_id || row.customerId || null,
    description: row.description || null,
    createdAt: row.created_at || row.createdAt,
    confirmedAt: row.confirmed_at || row.confirmedAt || null
  };
}

async function initialize() {
  if (initialized) {
    return;
  }

  if (USE_POSTGRES) {
    if (!process.env.DATABASE_URL) {
      throw new Error("DATABASE_URL is required.");
    }

    const { Pool } = require("pg");

    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      max: 5,
      connectionTimeoutMillis: 10000,
      idleTimeoutMillis: 30000,
      ssl: IS_PRODUCTION
        ? { rejectUnauthorized: false }
        : undefined
    });

    pool.on("error", function(error) {
      console.error("Unexpected PostgreSQL pool error:", error.message);
    });

    await pool.query(`
      CREATE TABLE IF NOT EXISTS merchants (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS api_keys (
        id TEXT PRIMARY KEY,
        merchant_id TEXT NOT NULL REFERENCES merchants(id),
        key_hash TEXT NOT NULL UNIQUE,
        key_prefix TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        revoked_at TIMESTAMPTZ
      )
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS customers (
        id TEXT PRIMARY KEY,
        merchant_id TEXT NOT NULL REFERENCES merchants(id),
        email TEXT NOT NULL,
        name TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS payments (
        id TEXT PRIMARY KEY,
        merchant_id TEXT NOT NULL REFERENCES merchants(id),
        amount BIGINT NOT NULL CHECK (amount > 0),
        currency TEXT NOT NULL,
        status TEXT NOT NULL,
        customer_id TEXT,
        description TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        confirmed_at TIMESTAMPTZ,
        FOREIGN KEY (customer_id, merchant_id)
          REFERENCES customers(id, merchant_id)
      )
    `);

    await pool.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS customers_id_merchant_unique
      ON customers (id, merchant_id)
    `);

    await pool.query(`
      CREATE INDEX IF NOT EXISTS api_keys_merchant_idx
      ON api_keys (merchant_id)
    `);

    await pool.query(`
      CREATE INDEX IF NOT EXISTS customers_merchant_idx
      ON customers (merchant_id)
    `);

    await pool.query(`
      CREATE INDEX IF NOT EXISTS payments_merchant_created_idx
      ON payments (merchant_id, created_at DESC)
    `);

    await pool.query(`
      CREATE INDEX IF NOT EXISTS payments_merchant_customer_idx
      ON payments (merchant_id, customer_id)
    `);

    const result = await pool.query(
      "SELECT id FROM merchants ORDER BY created_at ASC LIMIT 1"
    );

    if (result.rows.length) {
      defaultMerchantId = result.rows[0].id;
    }
  } else {
    if (!Array.isArray(database.merchants)) {
      database.merchants = [];
    }

    if (!Array.isArray(database.apiKeys)) {
      database.apiKeys = [];
    }

    if (!Array.isArray(database.customers)) {
      database.customers = [];
    }

    if (!Array.isArray(database.payments)) {
      database.payments = [];
    }

    const firstMerchant = database.merchants[0];

    if (firstMerchant) {
      defaultMerchantId = firstMerchant.id;
    }

    saveLocalDatabase();
  }

  initialized = true;
}

async function ensureMerchant(name, requestedId) {
  const id = requestedId || makeId("acct");

  if (USE_POSTGRES) {
    const existing = await pool.query(
      "SELECT * FROM merchants WHERE id = $1",
      [id]
    );

    if (existing.rows.length) {
      return normalizeMerchant(existing.rows[0]);
    }

    const result = await pool.query(
      `INSERT INTO merchants (id, name)
       VALUES ($1, $2)
       RETURNING *`,
      [id, name || "YourPay Merchant"]
    );

    if (!defaultMerchantId) {
      defaultMerchantId = id;
    }

    return normalizeMerchant(result.rows[0]);
  }

  let merchant = database.merchants.find(function(item) {
    return item.id === id;
  });

  if (!merchant) {
    merchant = {
      id: id,
      name: name || "YourPay Merchant",
      createdAt: new Date().toISOString()
    };

    database.merchants.push(merchant);
    saveLocalDatabase();
  }

  if (!defaultMerchantId) {
    defaultMerchantId = id;
  }

  return merchant;
}

async function getDefaultMerchantId() {
  if (defaultMerchantId) {
    return defaultMerchantId;
  }

  if (USE_POSTGRES) {
    const result = await pool.query(
      "SELECT id FROM merchants ORDER BY created_at ASC LIMIT 1"
    );

    if (result.rows.length) {
      defaultMerchantId = result.rows[0].id;
      return defaultMerchantId;
    }
  } else if (database.merchants.length) {
    defaultMerchantId = database.merchants[0].id;
    return defaultMerchantId;
  }

  const merchant = await ensureMerchant("Default Merchant");
  return merchant.id;
}

async function createMerchant(name) {
  const merchant = await ensureMerchant(name || "YourPay Merchant");
  return merchant;
}

async function addApiKey(apiKey) {
  const merchantId =
    apiKey.merchantId || await getDefaultMerchantId();

  if (!apiKey.keyHash) {
    throw new Error("API key hash is required.");
  }

  if (USE_POSTGRES) {
    await pool.query(
      `INSERT INTO api_keys
       (id, merchant_id, key_hash, key_prefix, created_at)
       VALUES ($1, $2, $3, $4, $5)`,
      [
        apiKey.id || makeId("key"),
        merchantId,
        apiKey.keyHash,
        apiKey.keyPrefix || "",
        apiKey.createdAt || new Date().toISOString()
      ]
    );

    return {
      id: apiKey.id,
      merchantId: merchantId,
      keyHash: apiKey.keyHash,
      keyPrefix: apiKey.keyPrefix,
      createdAt: apiKey.createdAt
    };
  }

  const record = {
    id: apiKey.id || makeId("key"),
    merchantId: merchantId,
    keyHash: apiKey.keyHash,
    keyPrefix: apiKey.keyPrefix || "",
    createdAt: apiKey.createdAt || new Date().toISOString(),
    revokedAt: null
  };

  database.apiKeys.push(record);
  saveLocalDatabase();

  return record;
}

async function findApiKey(keyHash) {
  if (USE_POSTGRES) {
    const result = await pool.query(
      `SELECT * FROM api_keys
       WHERE key_hash = $1 AND revoked_at IS NULL
       LIMIT 1`,
      [keyHash]
    );

    return normalizeApiKey(result.rows[0]);
  }

  const record = database.apiKeys.find(function(item) {
    return item.keyHash === keyHash && !item.revokedAt;
  });

  return normalizeApiKey(record);
}

async function revokeApiKey(id, merchantId) {
  if (USE_POSTGRES) {
    const result = await pool.query(
      `UPDATE api_keys
       SET revoked_at = NOW()
       WHERE id = $1 AND merchant_id = $2 AND revoked_at IS NULL
       RETURNING id`,
      [id, merchantId]
    );

    return result.rowCount > 0;
  }

  const record = database.apiKeys.find(function(item) {
    return item.id === id &&
      item.merchantId === merchantId &&
      !item.revokedAt;
  });

  if (!record) {
    return false;
  }

  record.revokedAt = new Date().toISOString();
  saveLocalDatabase();

  return true;
}

async function addCustomer(customer) {
  const merchantId =
    customer.merchantId || await getDefaultMerchantId();

  const record = {
    id: customer.id || makeId("cus"),
    merchantId: merchantId,
    email: customer.email,
    name: customer.name || null,
    createdAt: customer.createdAt || new Date().toISOString()
  };

  if (USE_POSTGRES) {
    const result = await pool.query(
      `INSERT INTO customers
       (id, merchant_id, email, name, created_at)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [
        record.id,
        record.merchantId,
        record.email,
        record.name,
        record.createdAt
      ]
    );

    return normalizeCustomer(result.rows[0]);
  }

  database.customers.push(record);
  saveLocalDatabase();

  return record;
}

async function getCustomer(id, merchantId) {
  if (USE_POSTGRES) {
    const result = merchantId
      ? await pool.query(
          "SELECT * FROM customers WHERE id = $1 AND merchant_id = $2",
          [id, merchantId]
        )
      : await pool.query(
          "SELECT * FROM customers WHERE id = $1",
          [id]
        );

    return normalizeCustomer(result.rows[0]);
  }

  const record = database.customers.find(function(customer) {
    return customer.id === id &&
      (!merchantId || customer.merchantId === merchantId);
  });

  return normalizeCustomer(record);
}

async function getCustomers(merchantId) {
  if (USE_POSTGRES) {
    const result = merchantId
      ? await pool.query(
          "SELECT * FROM customers WHERE merchant_id = $1 ORDER BY created_at DESC",
          [merchantId]
        )
      : await pool.query(
          "SELECT * FROM customers ORDER BY created_at DESC"
        );

    return result.rows.map(normalizeCustomer);
  }

  return database.customers
    .filter(function(customer) {
      return !merchantId || customer.merchantId === merchantId;
    })
    .slice()
    .reverse()
    .map(normalizeCustomer);
}

async function addPayment(payment) {
  const merchantId =
    payment.merchantId || await getDefaultMerchantId();

  const record = {
    id: payment.id || makeId("pi"),
    merchantId: merchantId,
    amount: Number(payment.amount),
    currency: String(payment.currency || "gbp").toLowerCase(),
    status: payment.status || "pending",
    customerId: payment.customerId || null,
    description: payment.description || null,
    createdAt: payment.createdAt || new Date().toISOString(),
    confirmedAt: payment.confirmedAt || null
  };

  if (
    !Number.isSafeInteger(record.amount) ||
    record.amount <= 0
  ) {
    throw new Error("Payment amount must be a positive safe integer.");
  }

  if (USE_POSTGRES) {
    const result = await pool.query(
      `INSERT INTO payments
       (id, merchant_id, amount, currency, status, customer_id,
        description, created_at, confirmed_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING *`,
      [
        record.id,
        record.merchantId,
        record.amount,
        record.currency,
        record.status,
        record.customerId,
        record.description,
        record.createdAt,
        record.confirmedAt
      ]
    );

    return normalizePayment(result.rows[0]);
  }

  if (record.customerId) {
    const customer = await getCustomer(
      record.customerId,
      merchantId
    );

    if (!customer) {
      throw new Error("Customer not found for this merchant.");
    }
  }

  database.payments.push(record);
  saveLocalDatabase();

  return record;
}

async function getPayment(id, merchantId) {
  if (USE_POSTGRES) {
    const result = merchantId
      ? await pool.query(
          "SELECT * FROM payments WHERE id = $1 AND merchant_id = $2",
          [id, merchantId]
        )
      : await pool.query(
          "SELECT * FROM payments WHERE id = $1",
          [id]
        );

    return normalizePayment(result.rows[0]);
  }

  const record = database.payments.find(function(payment) {
    return payment.id === id &&
      (!merchantId || payment.merchantId === merchantId);
  });

  return normalizePayment(record);
}

async function updatePayment(id, updates, merchantId) {
  const allowedFields = {
    status: "status",
    confirmedAt: "confirmed_at",
    description: "description"
  };

  const fields = Object.keys(updates).filter(function(key) {
    return Object.prototype.hasOwnProperty.call(allowedFields, key);
  });

  if (!fields.length) {
    return getPayment(id, merchantId);
  }

  if (
    updates.status &&
    !["pending", "succeeded", "failed", "canceled"].includes(updates.status)
  ) {
    throw new Error("Invalid payment status.");
  }

  if (USE_POSTGRES) {
    const values = [];
    const assignments = fields.map(function(field) {
      values.push(
        field === "confirmedAt" && updates[field]
          ? updates[field]
          : updates[field]
      );

      return allowedFields[field] + " = $" + values.length;
    });

    values.push(id);
    const idParameter = "$" + values.length;

    let where = "id = " + idParameter;

    if (merchantId) {
      values.push(merchantId);
      where += " AND merchant_id = $" + values.length;
    }

    const result = await pool.query(
      `UPDATE payments
       SET ${assignments.join(", ")}
       WHERE ${where}
       RETURNING *`,
      values
    );

    return normalizePayment(result.rows[0]);
  }

  const payment = database.payments.find(function(item) {
    return item.id === id &&
      (!merchantId || item.merchantId === merchantId);
  });

  if (!payment) {
    return null;
  }

  fields.forEach(function(field) {
    payment[field] = updates[field];
  });

  saveLocalDatabase();

  return normalizePayment(payment);
}

async function getPayments(merchantId) {
  if (USE_POSTGRES) {
    const result = merchantId
      ? await pool.query(
          "SELECT * FROM payments WHERE merchant_id = $1 ORDER BY created_at DESC",
          [merchantId]
        )
      : await pool.query(
          "SELECT * FROM payments ORDER BY created_at DESC"
        );

    return result.rows.map(normalizePayment);
  }

  return database.payments
    .filter(function(payment) {
      return !merchantId || payment.merchantId === merchantId;
    })
    .slice()
    .reverse()
    .map(normalizePayment);
}

async function getStats(merchantId) {
  if (USE_POSTGRES) {
    const values = [];
    let where = "";

    if (merchantId) {
      values.push(merchantId);
      where = " WHERE merchant_id = $1";
    }

    const paymentResult = await pool.query(
      `SELECT
         COUNT(*) AS payments,
         COUNT(*) FILTER (WHERE status = 'succeeded') AS successful_payments,
         COALESCE(
           SUM(amount) FILTER (WHERE status = 'succeeded'),
           0
         ) AS total_volume
       FROM payments${where}`,
      values
    );

    const customerResult = merchantId
      ? await pool.query(
          "SELECT COUNT(*) AS customers FROM customers WHERE merchant_id = $1",
          [merchantId]
        )
      : await pool.query(
          "SELECT COUNT(*) AS customers FROM customers"
        );

    const row = paymentResult.rows[0];

    return {
      totalVolume: Number(row.total_volume),
      successfulPayments: Number(row.successful_payments),
      customers: Number(customerResult.rows[0].customers),
      payments: Number(row.payments)
    };
  }

  const payments = database.payments.filter(function(payment) {
    return !merchantId || payment.merchantId === merchantId;
  });

  const customers = database.customers.filter(function(customer) {
    return !merchantId || customer.merchantId === merchantId;
  });

  const successfulPayments = payments.filter(function(payment) {
    return payment.status === "succeeded";
  });

  const totalVolume = successfulPayments.reduce(function(total, payment) {
    return total + Number(payment.amount || 0);
  }, 0);

  return {
    totalVolume: totalVolume,
    successfulPayments: successfulPayments.length,
    customers: customers.length,
    payments: payments.length
  };
}

async function healthCheck() {
  if (!initialized) {
    return false;
  }

  if (!USE_POSTGRES) {
    return true;
  }

  try {
    await pool.query("SELECT 1");
    return true;
  } catch (error) {
    return false;
  }
}

async function close() {
  if (pool) {
    await pool.end();
    pool = null;
  }

  initialized = false;
}

async function save() {
  if (!USE_POSTGRES) {
    saveLocalDatabase();
  }
}

module.exports = {
  database,
  initialize,
  healthCheck,
  close,
  save,
  makeId,
  createMerchant,
  getDefaultMerchantId,
  addApiKey,
  findApiKey,
  revokeApiKey,
  addCustomer,
  getCustomer,
  getCustomers,
  addPayment,
  getPayment,
  updatePayment,
  getPayments,
  getStats
};
