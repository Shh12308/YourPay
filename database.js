const fs = require('fs');
const path = require('path');

const dataDir = path.join(__dirname, '..', 'data');
const databaseFile = path.join(dataDir, 'database.json');

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
      'utf8'
    );
  }
}

function loadDatabase() {
  ensureDatabase();

  try {
    const raw = fs.readFileSync(databaseFile, 'utf8');

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
    console.error('Database read error:', error.message);
    throw error;
  }
}

function saveDatabase(data) {
  ensureDatabase();

  const temporaryFile = databaseFile + '.tmp';

  fs.writeFileSync(
    temporaryFile,
    JSON.stringify(data, null, 2),
    'utf8'
  );

  fs.renameSync(temporaryFile, databaseFile);
}

const database = loadDatabase();

function save() {
  saveDatabase(database);
}

function addApiKey(apiKey) {
  database.apiKeys.push(apiKey);
  save();
  return apiKey;
}

function findApiKey(key) {
  return database.apiKeys.find(function(item) {
    return item.key === key;
  }) || null;
}

function addCustomer(customer) {
  database.customers.push(customer);
  save();
  return customer;
}

function getCustomer(id) {
  return database.customers.find(function(customer) {
    return customer.id === id;
  }) || null;
}

function getCustomers() {
  return database.customers.slice().reverse();
}

function addPayment(payment) {
  database.payments.push(payment);
  save();
  return payment;
}

function getPayment(id) {
  return database.payments.find(function(payment) {
    return payment.id === id;
  }) || null;
}

function updatePayment(id, updates) {
  const payment = getPayment(id);

  if (!payment) {
    return null;
  }

  Object.keys(updates).forEach(function(key) {
    payment[key] = updates[key];
  });

  save();

  return payment;
}

function getPayments() {
  return database.payments.slice().reverse();
}

function getStats() {
  const payments = database.payments;
  const customers = database.customers;

  const successfulPayments = payments.filter(function(payment) {
    return payment.status === 'succeeded';
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

module.exports = {
  database,
  save,
  addApiKey,
  findApiKey,
  addCustomer,
  getCustomer,
  getCustomers,
  addPayment,
  getPayment,
  updatePayment,
  getPayments,
  getStats
};
