const fs = require("fs");
const path = require("path");

const usePostgres = Boolean(process.env.DATABASE_URL);

let pool = null;

if (usePostgres) {
  try {
    const { Pool } = require("pg");

    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      max: Number(process.env.DB_POOL_MAX || 10),
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 10000,
      ssl:
        process.env.NODE_ENV === "production"
          ? { rejectUnauthorized: false }
          : undefined
    });
  } catch (error) {
    console.error("PostgreSQL driver is unavailable:", error.message);
    process.exit(1);
  }
}

const dataDir = path.join(__dirname, "..", "data");
const databaseFile = path.join(dataDir, "database.json");

const emptyDatabase = {
  apiKeys: [],
  customers: [],
  payments: []
};

function ensureDatabase() {
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
}

function loadDatabase() {
  ensureDatabase();

  try {
    const raw = fs.readFileSync(databaseFile, "utf8");

    if (!raw.trim()) {
      return JSON.parse(JSON.stringify(emptyDatabase));
    }

    const data = JSON.parse(raw);

    return {
      apiKeys: Array.isArray(data.apiKeys) ? data.apiKeys : [],
      customers: Array.isArray(data.customers) ? data.customers : [],
      payments: Array.isArray(data.payments) ? data.payments : []
    };
  } catch (error) {
    console.error("Database read error:", error.message);
    throw error;
  }
}

function saveDatabase(data) {
  ensureDatabase();

  const temporaryFile = databaseFile + ".tmp";

  fs.writeFileSync(
    temporaryFile,
    JSON.stringify(data, null, 2),
    "utf8"
  );

  fs.renameSync(temporaryFile, databaseFile);
}

const localDatabase = usePostgres
  ? null
  : loadDatabase();

function saveLocal() {
  saveDatabase(localDatabase);
}

async function initialize() {
  if (!usePostgres) {
    return;
  }

  await pool.query(`
    CREATE TABLE IF NOT EXISTS api_keys (
      id BIGSERIAL PRIMARY KEY,
      key_hash TEXT NOT NULL UNIQUE,
      key_prefix TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      revoked_at TIMESTAMPTZ
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS customers (
      id TEXT PRIMARY KEY,
      email TEXT,
      name TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS payments (
      id TEXT PRIMARY KEY,
      amount BIGINT NOT NULL,
      currency TEXT NOT NULL,
      description TEXT NOT NULL,
      status TEXT NOT NULL,
      customer_id TEXT REFERENCES customers(id),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      confirmed_at TIMESTAMPTZ
    )
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS payments_created_at_idx
    ON payments(created_at DESC)
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS payments_customer_id_idx
    ON payments(customer_id)
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS customers_email_idx
    ON customers(email)
  `);
}

async function healthCheck() {
  if (!usePostgres) {
    return true;
  }

  await pool.query("SELECT 1");

  return true;
}

async function addApiKey(apiKey) {
  if (!usePostgres) {
    localDatabase.apiKeys.push(apiKey);
    saveLocal();
    return apiKey;
  }

  await pool.query(
    `
      INSERT INTO api_keys (
        key_hash,
        key_prefix,
        created_at
      )
      VALUES ($1, $2, $3)
    `,
    [
      apiKey.keyHash,
      apiKey.keyPrefix,
      apiKey.created
    ]
  );

  return apiKey;
}

async function findApiKey(keyHash) {
  if (!usePostgres) {
    return (
      localDatabase.apiKeys.find(function(item) {
        return item.keyHash === keyHash;
      }) || null
    );
  }

  const result = await pool.query(
    `
      SELECT
        key_prefix,
        created_at,
        revoked_at
      FROM api_keys
      WHERE key_hash = $1
      LIMIT 1
    `,
    [keyHash]
  );

  if (!result.rows.length) {
    return null;
  }

  const row = result.rows[0];

  if (row.revoked_at) {
    return null;
  }

  return {
    keyPrefix: row.key_prefix,
    created: row.created_at
  };
}

async function addCustomer(customer) {
  if (!usePostgres) {
    localDatabase.customers.push(customer);
    saveLocal();
    return customer;
  }

  await pool.query(
    `
      INSERT INTO customers (
        id,
        email,
        name,
        created_at
      )
      VALUES ($1, $2, $3, $4)
    `,
    [
      customer.id,
      customer.email,
      customer.name,
      customer.created
    ]
  );

  return customer;
}

async function getCustomer(id) {
  if (!usePostgres) {
    return (
      localDatabase.customers.find(function(customer) {
        return customer.id === id;
      }) || null
    );
  }

  const result = await pool.query(
    `
      SELECT
        id,
        email,
        name,
        created_at AS created
      FROM customers
      WHERE id = $1
      LIMIT 1
    `,
    [id]
  );

  return result.rows[0] || null;
}

async function getCustomers() {
  if (!usePostgres) {
    return localDatabase.customers
      .slice()
      .reverse();
  }

  const result = await pool.query(`
    SELECT
      id,
      email,
      name,
      created_at AS created
    FROM customers
    ORDER BY created_at DESC
    LIMIT 500
  `);

  return result.rows;
}

async function addPayment(payment) {
  if (!usePostgres) {
    localDatabase.payments.push(payment);
    saveLocal();
    return payment;
  }

  await pool.query(
    `
      INSERT INTO payments (
        id,
        amount,
        currency,
        description,
        status,
        customer_id,
        created_at
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7)
    `,
    [
      payment.id,
      payment.amount,
      payment.currency,
      payment.description,
      payment.status,
      payment.customer,
      payment.created
    ]
  );

  return payment;
}

async function getPayment(id) {
  if (!usePostgres) {
    return (
      localDatabase.payments.find(function(payment) {
        return payment.id === id;
      }) || null
    );
  }

  const result = await pool.query(
    `
      SELECT
        id,
        amount,
        currency,
        description,
        status,
        customer_id AS customer,
        created_at AS created,
        confirmed_at
      FROM payments
      WHERE id = $1
      LIMIT 1
    `,
    [id]
  );

  return result.rows[0] || null;
}

async function updatePayment(id, updates) {
  if (!usePostgres) {
    const payment = await getPayment(id);

    if (!payment) {
      return null;
    }

    Object.keys(updates).forEach(function(key) {
      payment[key] = updates[key];
    });

    saveLocal();

    return payment;
  }

  const allowed = {
    status: "status",
    confirmed_at: "confirmed_at",
    description: "description"
  };

  const fields = [];
  const values = [];
  let index = 1;

  Object.keys(updates).forEach(function(key) {
    if (!allowed[key]) {
      return;
    }

    fields.push(
      allowed[key] + " = $" + index
    );

    values.push(updates[key]);
    index += 1;
  });

  if (!fields.length) {
    return getPayment(id);
  }

  values.push(id);

  const result = await pool.query(
    `
      UPDATE payments
      SET ${fields.join(", ")}
      WHERE id = $${index}
      RETURNING
        id,
        amount,
        currency,
        description,
        status,
        customer_id AS customer,
        created_at AS created,
        confirmed_at
    `,
    values
  );

  return result.rows[0] || null;
}

async function getPayments() {
  if (!usePostgres) {
    return localDatabase.payments
      .slice()
      .reverse();
  }

  const result = await pool.query(`
    SELECT
      id,
      amount,
      currency,
      description,
      status,
      customer_id AS customer,
      created_at AS created,
      confirmed_at
    FROM payments
    ORDER BY created_at DESC
    LIMIT 1000
  `);

  return result.rows;
}

async function getStats() {
  if (!usePostgres) {
    const payments = localDatabase.payments;
    const customers = localDatabase.customers;

    const successfulPayments =
      payments.filter(function(payment) {
        return payment.status === "succeeded";
      });

    const totalVolume =
      successfulPayments.reduce(
        function(total, payment) {
          return (
            total +
            Number(payment.amount || 0)
          );
        },
        0
      );

    return {
      totalVolume,
      successfulPayments:
        successfulPayments.length,
      customers: customers.length,
      payments: payments.length
    };
  }

  const result = await pool.query(`
    SELECT
      COUNT(*)::INTEGER AS payments,
      COUNT(*) FILTER (
        WHERE status = 'succeeded'
      )::INTEGER AS successful_payments,
      COALESCE(
        SUM(amount) FILTER (
          WHERE status = 'succeeded'
        ),
        0
      )::BIGINT AS total_volume
    FROM payments
  `);

  const customers =
    await pool.query(`
      SELECT COUNT(*)::INTEGER AS customers
      FROM customers
    `);

  return {
    totalVolume:
      Number(result.rows[0].total_volume),
    successfulPayments:
      result.rows[0].successful_payments,
    customers:
      customers.rows[0].customers,
    payments:
      result.rows[0].payments
  };
}

async function close() {
  if (pool) {
    await pool.end();
  }
}

module.exports = {
  initialize,
  healthCheck,
  close,
  addApiKey,
  findApiKey,
  addCustomer,
  getCustomer,
  getCustomers,
  addPayment,
  getPayment,
  updatePayment,
  getPayments,
  getStats,
  usePostgres
};
