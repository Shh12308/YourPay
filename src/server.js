const http = require("http");
const crypto = require("crypto");
const db = require("./database");

const PORT = Number(process.env.PORT || 4242);
const HOST = "0.0.0.0";
const NODE_ENV = process.env.NODE_ENV || "development";
const IS_PRODUCTION = NODE_ENV === "production";

const MAX_BODY_SIZE = 1024 * 1024;
const RATE_LIMIT_WINDOW = 60 * 1000;
const RATE_LIMIT_MAX = 120;

const rateLimitStore = new Map();

function makeId(prefix) {
  return prefix + "_" + crypto.randomBytes(16).toString("hex");
}

function makeApiKey() {
  return "yp_test_" + crypto.randomBytes(32).toString("hex");
}

function hashApiKey(key) {
  return crypto.createHash("sha256").update(key).digest("hex");
}

function sendJson(res, statusCode, data, requestId) {
  const body = JSON.stringify(data);

  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "X-Request-ID": requestId
  });

  res.end(body);
}

function sendHtml(res, statusCode, html, requestId) {
  res.writeHead(statusCode, {
    "Content-Type": "text/html; charset=utf-8",
    "Content-Length": Buffer.byteLength(html),
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "strict-origin-when-cross-origin",
    "X-Request-ID": requestId
  });

  res.end(html);
}

function setSecurityHeaders(res) {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");

  if (IS_PRODUCTION) {
    res.setHeader(
      "Strict-Transport-Security",
      "max-age=31536000; includeSubDomains"
    );
  }
}

function getClientIp(req) {
  const forwarded = req.headers["x-forwarded-for"];

  if (forwarded) {
    return String(forwarded).split(",")[0].trim();
  }

  return req.socket.remoteAddress || "unknown";
}

function checkRateLimit(req) {
  const ip = getClientIp(req);
  const now = Date.now();

  let record = rateLimitStore.get(ip);

  if (!record || now - record.startedAt >= RATE_LIMIT_WINDOW) {
    record = {
      startedAt: now,
      count: 0
    };

    rateLimitStore.set(ip, record);
  }

  record.count += 1;

  return {
    allowed: record.count <= RATE_LIMIT_MAX,
    remaining: Math.max(0, RATE_LIMIT_MAX - record.count)
  };
}

function cleanRateLimitStore() {
  const now = Date.now();

  for (const [ip, record] of rateLimitStore.entries()) {
    if (now - record.startedAt >= RATE_LIMIT_WINDOW) {
      rateLimitStore.delete(ip);
    }
  }
}

setInterval(cleanRateLimitStore, RATE_LIMIT_WINDOW).unref();

function parseBody(req) {
  return new Promise(function(resolve, reject) {
    let body = "";
    let size = 0;
    let rejected = false;

    req.on("data", function(chunk) {
      if (rejected) {
        return;
      }

      size += chunk.length;

      if (size > MAX_BODY_SIZE) {
        rejected = true;
        reject(new Error("REQUEST_TOO_LARGE"));
        return;
      }

      body += chunk.toString("utf8");
    });

    req.on("end", function() {
      if (rejected) {
        return;
      }

      if (!body) {
        resolve({});
        return;
      }

      try {
        resolve(JSON.parse(body));
      } catch (error) {
        reject(new Error("INVALID_JSON"));
      }
    });

    req.on("error", function(error) {
      if (!rejected) {
        reject(error);
      }
    });
  });
}

function isJsonRequest(req) {
  const contentType = String(req.headers["content-type"] || "").toLowerCase();
  return contentType.indexOf("application/json") === 0;
}

function getApiKey(req) {
  const authorization = String(req.headers.authorization || "");

  if (!authorization.startsWith("Bearer ")) {
    return null;
  }

  const key = authorization.slice(7).trim();

  return key || null;
}

async function requireApiKey(req, res, requestId) {
  const key = getApiKey(req);

  if (!key) {
    sendJson(
      res,
      401,
      {
        error: {
          type: "authentication_error",
          message: "Missing API key."
        }
      },
      requestId
    );

    return null;
  }

  const keyHash = hashApiKey(key);
  const record = await db.findApiKey(keyHash);

  if (!record) {
    sendJson(
      res,
      401,
      {
        error: {
          type: "authentication_error",
          message: "Invalid API key."
        }
      },
      requestId
    );

    return null;
  }

  return record;
}

function money(amount) {
  return (Number(amount || 0) / 100).toFixed(2);
}

function formatDate(value) {
  if (!value) {
    return "";
  }

  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return String(value);
  }

  return date.toLocaleString("en-GB");
}

function escapeHtml(value) {
  return String(value === undefined || value === null ? "" : value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function validEmail(email) {
  if (typeof email !== "string") {
    return false;
  }

  if (email.length > 320) {
    return false;
  }

  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function validCurrency(currency) {
  return (
    typeof currency === "string" &&
    /^[a-zA-Z]{3}$/.test(currency)
  );
}

function validAmount(amount) {
  return (
    Number.isSafeInteger(amount) &&
    amount > 0 &&
    amount <= 1000000000
  );
}

function errorResponse(res, requestId, statusCode, type, message) {
  sendJson(
    res,
    statusCode,
    {
      error: {
        type: type,
        message: message
      }
    },
    requestId
  );
}

function dashboardAuth(req, res) {
  const username = process.env.DASHBOARD_USERNAME;
  const password = process.env.DASHBOARD_PASSWORD;

  if (!IS_PRODUCTION) {
    return true;
  }

  if (!username || !password) {
    return false;
  }

  const authorization = String(req.headers.authorization || "");

  if (!authorization.startsWith("Basic ")) {
    res.writeHead(401, {
      "WWW-Authenticate": 'Basic realm="YourPay Dashboard"',
      "Content-Type": "text/plain; charset=utf-8"
    });

    res.end("Dashboard authentication required.");
    return false;
  }

  const encoded = authorization.slice(6).trim();

  let decoded;

  try {
    decoded = Buffer.from(encoded, "base64").toString("utf8");
  } catch (error) {
    decoded = "";
  }

  const separator = decoded.indexOf(":");

  if (separator === -1) {
    res.writeHead(401, {
      "WWW-Authenticate": 'Basic realm="YourPay Dashboard"',
      "Content-Type": "text/plain; charset=utf-8"
    });

    res.end("Invalid dashboard credentials.");
    return false;
  }

  const suppliedUsername = decoded.slice(0, separator);
  const suppliedPassword = decoded.slice(separator + 1);

  if (
    suppliedUsername !== username ||
    suppliedPassword !== password
  ) {
    res.writeHead(401, {
      "WWW-Authenticate": 'Basic realm="YourPay Dashboard"',
      "Content-Type": "text/plain; charset=utf-8"
    });

    res.end("Invalid dashboard credentials.");
    return false;
  }

  return true;
}

function dashboardHtml(stats, payments, customers) {
  const paymentRows = payments
    .map(function(payment) {
      return `
        <tr>
          <td>${escapeHtml(payment.id)}</td>
          <td>${escapeHtml(payment.currency || "gbp").toUpperCase()} ${money(payment.amount)}</td>
          <td><span class="status ${escapeHtml(payment.status)}">${escapeHtml(payment.status)}</span></td>
          <td>${escapeHtml(payment.customerId || payment.customer_id || "—")}</td>
          <td>${escapeHtml(formatDate(payment.createdAt || payment.created_at))}</td>
        </tr>
      `;
    })
    .join("");

  const customerRows = customers
    .map(function(customer) {
      return `
        <tr>
          <td>${escapeHtml(customer.id)}</td>
          <td>${escapeHtml(customer.email)}</td>
          <td>${escapeHtml(customer.name || "—")}</td>
          <td>${escapeHtml(formatDate(customer.createdAt || customer.created_at))}</td>
        </tr>
      `;
    })
    .join("");

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>YourPay Dashboard</title>
<style>
* {
  box-sizing: border-box;
}

body {
  margin: 0;
  background: #f5f7fb;
  color: #172033;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
}

header {
  background: #111827;
  color: white;
  padding: 18px 24px;
}

header strong {
  font-size: 20px;
}

main {
  max-width: 1200px;
  margin: 0 auto;
  padding: 24px;
}

.grid {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 16px;
  margin-bottom: 24px;
}

.card {
  background: white;
  border: 1px solid #e5e7eb;
  border-radius: 14px;
  padding: 20px;
  box-shadow: 0 2px 8px rgba(0,0,0,.04);
}

.label {
  color: #6b7280;
  font-size: 13px;
  margin-bottom: 8px;
}

.value {
  font-size: 28px;
  font-weight: 700;
}

.section {
  background: white;
  border: 1px solid #e5e7eb;
  border-radius: 14px;
  margin-bottom: 24px;
  overflow: hidden;
}

.section h2 {
  margin: 0;
  padding: 20px;
  font-size: 18px;
  border-bottom: 1px solid #e5e7eb;
}

.table-wrap {
  overflow-x: auto;
}

table {
  width: 100%;
  border-collapse: collapse;
  min-width: 700px;
}

th,
td {
  text-align: left;
  padding: 14px 20px;
  border-bottom: 1px solid #f0f2f5;
  font-size: 14px;
}

th {
  color: #6b7280;
  font-weight: 600;
}

.status {
  display: inline-block;
  padding: 5px 9px;
  border-radius: 999px;
  font-size: 12px;
  font-weight: 600;
}

.status.succeeded {
  background: #dcfce7;
  color: #166534;
}

.status.pending {
  background: #fef3c7;
  color: #92400e;
}

.status.failed {
  background: #fee2e2;
  color: #991b1b;
}

.empty {
  padding: 30px 20px;
  color: #6b7280;
}

.notice {
  background: #fff7ed;
  border: 1px solid #fed7aa;
  color: #9a3412;
  padding: 16px;
  border-radius: 12px;
  margin-bottom: 24px;
}

a {
  color: #2563eb;
  text-decoration: none;
}

@media (max-width: 800px) {
  .grid {
    grid-template-columns: repeat(2, 1fr);
  }
}

@media (max-width: 500px) {
  main {
    padding: 14px;
  }

  .grid {
    grid-template-columns: 1fr;
  }
}
</style>
</head>
<body>
<header>
  <strong>YourPay</strong>
</header>

<main>
  ${
    IS_PRODUCTION
      ? ""
      : `<div class="notice">
          Test/development mode is active. Payments created through the checkout are simulated and do not move real money.
        </div>`
  }

  <div class="grid">
    <div class="card">
      <div class="label">Total volume</div>
      <div class="value">£${money(stats.totalVolume)}</div>
    </div>

    <div class="card">
      <div class="label">Successful payments</div>
      <div class="value">${stats.successfulPayments}</div>
    </div>

    <div class="card">
      <div class="label">Customers</div>
      <div class="value">${stats.customers}</div>
    </div>

    <div class="card">
      <div class="label">All payments</div>
      <div class="value">${stats.payments}</div>
    </div>
  </div>

  <div class="section">
    <h2>Payments</h2>

    ${
      payments.length
        ? `<div class="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>ID</th>
                  <th>Amount</th>
                  <th>Status</th>
                  <th>Customer</th>
                  <th>Created</th>
                </tr>
              </thead>
              <tbody>${paymentRows}</tbody>
            </table>
          </div>`
        : `<div class="empty">No payments yet.</div>`
    }
  </div>

  <div class="section">
    <h2>Customers</h2>

    ${
      customers.length
        ? `<div class="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>ID</th>
                  <th>Email</th>
                  <th>Name</th>
                  <th>Created</th>
                </tr>
              </thead>
              <tbody>${customerRows}</tbody>
            </table>
          </div>`
        : `<div class="empty">No customers yet.</div>`
    }
  </div>

  <div class="section">
    <h2>Test checkout</h2>
    <div class="empty">
      <a href="/checkout">Open YourPay test checkout</a>
    </div>
  </div>
</main>
</body>
</html>`;
}

function checkoutHtml() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>YourPay Checkout</title>
<style>
* {
  box-sizing: border-box;
}

body {
  margin: 0;
  background: #f4f6f8;
  color: #172033;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
}

.wrap {
  width: 100%;
  max-width: 480px;
  margin: 0 auto;
  padding: 20px;
}

.card {
  background: white;
  border: 1px solid #e5e7eb;
  border-radius: 18px;
  padding: 24px;
  box-shadow: 0 8px 30px rgba(0,0,0,.07);
}

.logo {
  font-size: 22px;
  font-weight: 800;
  margin-bottom: 24px;
}

.product {
  border-bottom: 1px solid #e5e7eb;
  padding-bottom: 20px;
  margin-bottom: 20px;
}

.product-name {
  font-size: 18px;
  font-weight: 700;
}

.price {
  font-size: 28px;
  font-weight: 800;
  margin-top: 8px;
}

label {
  display: block;
  margin-top: 16px;
  margin-bottom: 7px;
  font-size: 13px;
  font-weight: 600;
}

input {
  width: 100%;
  padding: 13px;
  border: 1px solid #d1d5db;
  border-radius: 10px;
  font-size: 16px;
}

.row {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 12px;
}

button {
  width: 100%;
  border: 0;
  border-radius: 10px;
  padding: 15px;
  margin-top: 22px;
  background: #111827;
  color: white;
  font-size: 16px;
  font-weight: 700;
  cursor: pointer;
}

button:disabled {
  opacity: .6;
}

.message {
  margin-top: 16px;
  padding: 12px;
  border-radius: 10px;
  display: none;
}

.success {
  display: block;
  background: #dcfce7;
  color: #166534;
}

.error {
  display: block;
  background: #fee2e2;
  color: #991b1b;
}

.test {
  margin-top: 18px;
  padding: 12px;
  border-radius: 10px;
  background: #eff6ff;
  color: #1e40af;
  font-size: 13px;
}

@media (max-width: 400px) {
  .wrap {
    padding: 12px;
  }

  .card {
    padding: 18px;
  }
}
</style>
</head>
<body>
<div class="wrap">
  <div class="card">
    <div class="logo">YourPay</div>

    <div class="product">
      <div class="product-name">Test Product</div>
      <div class="price">£10.00</div>
    </div>

    <form id="paymentForm">
      <label for="email">Email</label>
      <input
        id="email"
        name="email"
        type="email"
        autocomplete="email"
        placeholder="you@example.com"
        required
      >

      <label for="card">Card number</label>
      <input
        id="card"
        name="card"
        inputmode="numeric"
        autocomplete="cc-number"
        maxlength="19"
        placeholder="4242 4242 4242 4242"
        required
      >

      <div class="row">
        <div>
          <label for="expiry">Expiry</label>
          <input
            id="expiry"
            name="expiry"
            inputmode="numeric"
            autocomplete="cc-exp"
            maxlength="5"
            placeholder="12/30"
            required
          >
        </div>

        <div>
          <label for="cvc">CVC</label>
          <input
            id="cvc"
            name="cvc"
            inputmode="numeric"
            autocomplete="cc-csc"
            maxlength="4"
            placeholder="123"
            required
          >
        </div>
      </div>

      <button id="payButton" type="submit">
        Pay £10.00
      </button>

      <div id="message" class="message"></div>
    </form>

    <div class="test">
      Test mode only. Use card 4242 4242 4242 4242, expiry 12/30 and CVC 123.
      No real money is moved.
    </div>
  </div>
</div>

<script>
const form = document.getElementById("paymentForm");
const button = document.getElementById("payButton");
const message = document.getElementById("message");

form.addEventListener("submit", async function(event) {
  event.preventDefault();

  button.disabled = true;
  button.textContent = "Processing...";
  message.className = "message";
  message.textContent = "";

  const payload = {
    email: document.getElementById("email").value,
    card: document.getElementById("card").value,
    expiry: document.getElementById("expiry").value,
    cvc: document.getElementById("cvc").value
  };

  try {
    const response = await fetch("/checkout/pay", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify(payload)
    });

    const data = await response.json();

    if (!response.ok) {
      throw new Error(
        data &&
        data.error &&
        data.error.message
          ? data.error.message
          : "Payment failed."
      );
    }

    message.className = "message success";
    message.textContent =
      "Payment successful. Payment ID: " +
      data.payment.id;

    form.reset();
  } catch (error) {
    message.className = "message error";
    message.textContent = error.message || "Payment failed.";
  } finally {
    button.disabled = false;
    button.textContent = "Pay £10.00";
  }
});
</script>
</body>
</html>`;
}

async function handleRequest(req, res) {
  const requestId = makeId("req");

  setSecurityHeaders(res);
  res.setHeader("X-Request-ID", requestId);

  const rateLimit = checkRateLimit(req);

  res.setHeader("X-RateLimit-Limit", String(RATE_LIMIT_MAX));
  res.setHeader("X-RateLimit-Remaining", String(rateLimit.remaining));

  if (!rateLimit.allowed) {
    res.setHeader("Retry-After", "60");

    errorResponse(
      res,
      requestId,
      429,
      "rate_limit_error",
      "Too many requests. Please try again later."
    );

    return;
  }

  const url = new URL(
    req.url,
    "http://" + (req.headers.host || "localhost")
  );

  const pathname = url.pathname;

  try {
    if (req.method === "GET" && pathname === "/") {
      sendJson(
        res,
        200,
        {
          name: "YourPay",
          status: "online",
          environment: NODE_ENV
        },
        requestId
      );

      return;
    }

    if (req.method === "GET" && pathname === "/health") {
      const healthy = await db.healthCheck();

      if (!healthy) {
        errorResponse(
          res,
          requestId,
          503,
          "service_unavailable",
          "Database unavailable."
        );

        return;
      }

      sendJson(
        res,
        200,
        {
          status: "ok"
        },
        requestId
      );

      return;
    }

    if (req.method === "GET" && pathname === "/dashboard") {
      if (!dashboardAuth(req, res)) {
        return;
      }

      const stats = await db.getStats();
      const payments = await db.getPayments();
      const customers = await db.getCustomers();

      sendHtml(
        res,
        200,
        dashboardHtml(stats, payments, customers),
        requestId
      );

      return;
    }

    if (req.method === "GET" && pathname === "/checkout") {
      if (IS_PRODUCTION) {
        errorResponse(
          res,
          requestId,
          403,
          "forbidden",
          "Test checkout is disabled in production."
        );

        return;
      }

      sendHtml(res, 200, checkoutHtml(), requestId);
      return;
    }

    if (req.method === "POST" && pathname === "/dev/api-keys") {
      if (IS_PRODUCTION) {
        errorResponse(
          res,
          requestId,
          404,
          "not_found",
          "Not found."
        );

        return;
      }

      const key = makeApiKey();
      const keyHash = hashApiKey(key);

      await db.addApiKey({
        id: makeId("key"),
        keyHash: keyHash,
        keyPrefix: key.slice(0, 12),
        createdAt: new Date().toISOString()
      });

      sendJson(
        res,
        201,
        {
          apiKey: key,
          warning: "Store this key securely. It will not be shown again."
        },
        requestId
      );

      return;
    }

    if (req.method === "POST" && pathname === "/checkout/pay") {
      if (IS_PRODUCTION) {
        errorResponse(
          res,
          requestId,
          403,
          "forbidden",
          "Test checkout is disabled in production."
        );

        return;
      }

      if (!isJsonRequest(req)) {
        errorResponse(
          res,
          requestId,
          415,
          "invalid_request_error",
          "Content-Type must be application/json."
        );

        return;
      }

      const body = await parseBody(req);

      if (!validEmail(body.email)) {
        errorResponse(
          res,
          requestId,
          400,
          "invalid_request_error",
          "A valid email address is required."
        );

        return;
      }

      const payment = await db.addPayment({
        id: makeId("pi"),
        amount: 1000,
        currency: "gbp",
        status: "succeeded",
        customerId: null,
        description: "Test Product",
        createdAt: new Date().toISOString()
      });

      sendJson(
        res,
        201,
        {
          payment: payment
        },
        requestId
      );

      return;
    }

    if (req.method === "POST" && pathname === "/v1/customers") {
      if (!isJsonRequest(req)) {
        errorResponse(
          res,
          requestId,
          415,
          "invalid_request_error",
          "Content-Type must be application/json."
        );

        return;
      }

      const apiKey = await requireApiKey(req, res, requestId);

      if (!apiKey) {
        return;
      }

      const body = await parseBody(req);

      if (!validEmail(body.email)) {
        errorResponse(
          res,
          requestId,
          400,
          "invalid_request_error",
          "A valid email address is required."
        );

        return;
      }

      if (
        body.name !== undefined &&
        (typeof body.name !== "string" || body.name.length > 200)
      ) {
        errorResponse(
          res,
          requestId,
          400,
          "invalid_request_error",
          "Name must be a string with a maximum length of 200 characters."
        );

        return;
      }

      const customer = await db.addCustomer({
        id: makeId("cus"),
        email: body.email.trim().toLowerCase(),
        name: body.name ? body.name.trim() : null,
        createdAt: new Date().toISOString()
      });

      sendJson(
        res,
        201,
        {
          customer: customer
        },
        requestId
      );

      return;
    }

    if (
      req.method === "POST" &&
      pathname === "/v1/payment_intents"
    ) {
      if (!isJsonRequest(req)) {
        errorResponse(
          res,
          requestId,
          415,
          "invalid_request_error",
          "Content-Type must be application/json."
        );

        return;
      }

      const apiKey = await requireApiKey(req, res, requestId);

      if (!apiKey) {
        return;
      }

      const body = await parseBody(req);

      const amount = Number(body.amount);
      const currency = body.currency
        ? String(body.currency).toLowerCase()
        : "gbp";

      if (!validAmount(amount)) {
        errorResponse(
          res,
          requestId,
          400,
          "invalid_request_error",
          "Amount must be a positive integer representing the smallest currency unit."
        );

        return;
      }

      if (!validCurrency(currency)) {
        errorResponse(
          res,
          requestId,
          400,
          "invalid_request_error",
          "Currency must be a 3-letter currency code."
        );

        return;
      }

      if (
        body.description !== undefined &&
        (
          typeof body.description !== "string" ||
          body.description.length > 500
        )
      ) {
        errorResponse(
          res,
          requestId,
          400,
          "invalid_request_error",
          "Description must be a string with a maximum length of 500 characters."
        );

        return;
      }

      let customerId = body.customer || body.customerId || null;

      if (customerId) {
        const customer = await db.getCustomer(customerId);

        if (!customer) {
          errorResponse(
            res,
            requestId,
            400,
            "invalid_request_error",
            "Customer does not exist."
          );

          return;
        }
      }

      const payment = await db.addPayment({
        id: makeId("pi"),
        amount: amount,
        currency: currency,
        status: "pending",
        customerId: customerId,
        description: body.description
          ? body.description.trim()
          : null,
        createdAt: new Date().toISOString()
      });

      sendJson(
        res,
        201,
        {
          payment_intent: payment
        },
        requestId
      );

      return;
    }

    const paymentMatch = pathname.match(
      /^\/v1\/payment_intents\/([^/]+)$/
    );

    if (
      req.method === "GET" &&
      paymentMatch
    ) {
      const apiKey = await requireApiKey(req, res, requestId);

      if (!apiKey) {
        return;
      }

      const payment = await db.getPayment(paymentMatch[1]);

      if (!payment) {
        errorResponse(
          res,
          requestId,
          404,
          "resource_missing",
          "Payment intent not found."
        );

        return;
      }

      sendJson(
        res,
        200,
        {
          payment_intent: payment
        },
        requestId
      );

      return;
    }

    const confirmMatch = pathname.match(
      /^\/v1\/payment_intents\/([^/]+)\/confirm$/
    );

    if (
      req.method === "POST" &&
      confirmMatch
    ) {
      const apiKey = await requireApiKey(req, res, requestId);

      if (!apiKey) {
        return;
      }

      const paymentId = confirmMatch[1];
      const payment = await db.getPayment(paymentId);

      if (!payment) {
        errorResponse(
          res,
          requestId,
          404,
          "resource_missing",
          "Payment intent not found."
        );

        return;
      }

      if (payment.status === "succeeded") {
        sendJson(
          res,
          200,
          {
            payment_intent: payment
          },
          requestId
        );

        return;
      }

      if (payment.status !== "pending") {
        errorResponse(
          res,
          requestId,
          400,
          "invalid_request_error",
          "This payment intent cannot be confirmed."
        );

        return;
      }

      const updatedPayment = await db.updatePayment(
        paymentId,
        {
          status: "succeeded",
          confirmedAt: new Date().toISOString()
        }
      );

      sendJson(
        res,
        200,
        {
          payment_intent: updatedPayment
        },
        requestId
      );

      return;
    }

    errorResponse(
      res,
      requestId,
      404,
      "not_found",
      "Route not found."
    );
  } catch (error) {
    if (error.message === "REQUEST_TOO_LARGE") {
      errorResponse(
        res,
        requestId,
        413,
        "invalid_request_error",
        "Request body is too large."
      );

      return;
    }

    if (error.message === "INVALID_JSON") {
      errorResponse(
        res,
        requestId,
        400,
        "invalid_request_error",
        "Request body must contain valid JSON."
      );

      return;
    }

    console.error(
      JSON.stringify({
        level: "error",
        requestId: requestId,
        message: error.message,
        stack: error.stack
      })
    );

    errorResponse(
      res,
      requestId,
      500,
      "api_error",
      "An internal error occurred."
    );
  }
}

let server;

async function start() {
  try {
    await db.initialize();

    server = http.createServer(function(req, res) {
      handleRequest(req, res);
    });

    server.listen(PORT, HOST, function() {
      console.log(
        "YourPay listening on http://" +
        HOST +
        ":" +
        PORT
      );

      console.log(
        "Environment: " + NODE_ENV
      );
    });
  } catch (error) {
    console.error("Failed to start YourPay:", error.message);
    process.exit(1);
  }
}

async function shutdown(signal) {
  console.log(signal + " received. Shutting down.");

  if (!server) {
    process.exit(0);
  }

  server.close(async function() {
    try {
      await db.close();
      process.exit(0);
    } catch (error) {
      console.error("Shutdown error:", error.message);
      process.exit(1);
    }
  });

  setTimeout(function() {
    console.error("Forced shutdown.");
    process.exit(1);
  }, 10000).unref();
}

process.on("SIGTERM", function() {
  shutdown("SIGTERM");
});

process.on("SIGINT", function() {
  shutdown("SIGINT");
});

process.on("uncaughtException", function(error) {
  console.error("Uncaught exception:", error);
  shutdown("uncaughtException");
});

process.on("unhandledRejection", function(error) {
  console.error("Unhandled rejection:", error);
  shutdown("unhandledRejection");
});

start();
