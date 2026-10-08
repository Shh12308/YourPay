const http = require("http");
const crypto = require("crypto");
const db = require("./database");

const PORT = 4242;

function sendJson(res, status, data) {
  const body = JSON.stringify(data, null, 2);

  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(body)
  });

  res.end(body);
}

function sendHtml(res, status, html) {
  res.writeHead(status, {
    "Content-Type": "text/html; charset=utf-8",
    "Content-Length": Buffer.byteLength(html)
  });

  res.end(html);
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";

    req.on("data", chunk => {
      body += chunk;

      if (body.length > 1024 * 1024) {
        reject(new Error("Request body too large"));
        req.destroy();
      }
    });

    req.on("end", () => {
      if (!body) {
        resolve({});
        return;
      }

      try {
        resolve(JSON.parse(body));
      } catch (error) {
        reject(error);
      }
    });

    req.on("error", reject);
  });
}

function makeId(prefix) {
  return prefix + "_" + crypto.randomBytes(8).toString("hex");
}

function getApiKey(req) {
  const auth = req.headers.authorization || "";

  if (!auth.startsWith("Bearer ")) {
    return null;
  }

  return auth.slice(7);
}

function requireApiKey(req, res) {
  const key = getApiKey(req);

  if (!key || !db.findApiKey(key)) {
    sendJson(res, 401, {
      error: {
        type: "authentication_error",
        message: "Invalid or missing API key."
      }
    });

    return false;
  }

  return true;
}

function money(amount) {
  return "£" + (Number(amount || 0) / 100).toFixed(2);
}

function formatDate(date) {
  return new Date(date).toLocaleString("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit"
  });
}

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function dashboardHtml() {
  const allPayments = db.getPayments();

  const allCustomers = db.getCustomers();

  const successful = allPayments.filter(
    payment => payment.status === "succeeded"
  );

  const pending = allPayments.filter(
    payment =>
      payment.status === "requires_confirmation" ||
      payment.status === "pending"
  );

  const failed = allPayments.filter(
    payment => payment.status === "failed"
  );

  const totalRevenue = successful.reduce(
    (sum, payment) => sum + Number(payment.amount || 0),
    0
  );

  const successfulRevenue = totalRevenue;

  const paymentRows = allPayments
    .map(payment => {
      const statusClass =
        payment.status === "succeeded"
          ? "success"
          : payment.status === "failed"
          ? "danger"
          : "warning";

      return `
        <tr
          data-status="${escapeHtml(payment.status)}"
          data-search="${escapeHtml(
            payment.id +
            " " +
            payment.description +
            " " +
            payment.status
          ).toLowerCase()}"
          onclick="showPayment('${escapeHtml(payment.id)}')"
        >
          <td>
            <div class="payment-cell">
              <div class="payment-icon">£</div>
              <div>
                <strong>${escapeHtml(payment.id)}</strong>
                <span>${formatDate(payment.created)}</span>
              </div>
            </div>
          </td>

          <td>
            ${escapeHtml(payment.description)}
          </td>

          <td>
            <strong>${money(payment.amount)}</strong>
          </td>

          <td>
            <span class="status ${statusClass}">
              <span class="status-dot"></span>
              ${escapeHtml(payment.status.replace(/_/g, " "))}
            </span>
          </td>

          <td>
            <button
              class="row-button"
              onclick="event.stopPropagation(); showPayment('${escapeHtml(
                payment.id
              )}')"
            >
              View
            </button>
          </td>
        </tr>
      `;
    })
    .join("");

  const emptyRows = `
    <tr id="empty-row">
      <td colspan="5">
        <div class="empty-state">
          <div class="empty-icon">£</div>
          <h3>No payments yet</h3>
          <p>Your payment activity will appear here.</p>
          <a href="/checkout" class="primary-button">Open checkout</a>
        </div>
      </td>
    </tr>
  `;

  return `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="theme-color" content="#0a2540">

  <title>YourPay Dashboard</title>

  <style>
    * {
      box-sizing: border-box;
    }

    :root {
      --navy: #0a2540;
      --blue: #635bff;
      --blue-dark: #4f46e5;
      --background: #f6f9fc;
      --border: #e6ebf1;
      --text: #1a1f36;
      --muted: #697386;
      --green: #0e9f6e;
      --red: #df1b41;
      --yellow: #a15c00;
      --white: #ffffff;
    }

    body {
      margin: 0;
      background: var(--background);
      color: var(--text);
      font-family:
        -apple-system,
        BlinkMacSystemFont,
        "Segoe UI",
        sans-serif;
    }

    button,
    input,
    select {
      font: inherit;
    }

    a {
      color: inherit;
    }

    .app {
      display: flex;
      min-height: 100vh;
    }

    .sidebar {
      width: 250px;
      min-height: 100vh;
      background: var(--navy);
      color: white;
      padding: 22px 14px;
      position: fixed;
      left: 0;
      top: 0;
      bottom: 0;
      z-index: 20;
    }

    .brand {
      padding: 8px 12px 28px;
      font-size: 24px;
      font-weight: 800;
      letter-spacing: -0.7px;
    }

    .brand span {
      color: #a5b4fc;
    }

    .workspace {
      padding: 10px 12px;
      margin-bottom: 18px;
      border: 1px solid rgba(255,255,255,0.12);
      border-radius: 9px;
      color: #d9e2ec;
      font-size: 13px;
    }

    .workspace-title {
      color: white;
      font-weight: 700;
      margin-bottom: 3px;
    }

    .nav-section {
      margin: 22px 8px 8px;
      color: #7f95aa;
      text-transform: uppercase;
      font-size: 10px;
      letter-spacing: 1px;
      font-weight: 700;
    }

    .nav a {
      display: flex;
      align-items: center;
      gap: 11px;
      padding: 10px 12px;
      margin: 3px 0;
      border-radius: 7px;
      color: #c8d3df;
      text-decoration: none;
      font-size: 14px;
    }

    .nav a:hover,
    .nav a.active {
      background: rgba(99, 91, 255, 0.18);
      color: white;
    }

    .nav-icon {
      width: 19px;
      text-align: center;
      font-weight: 700;
    }

    .sidebar-bottom {
      position: absolute;
      left: 14px;
      right: 14px;
      bottom: 18px;
    }

    .mode {
      padding: 11px 12px;
      border-radius: 8px;
      background: rgba(255,255,255,0.07);
      color: #cbd5e1;
      font-size: 12px;
    }

    .mode strong {
      display: block;
      color: #fbbf24;
      margin-bottom: 3px;
    }

    .main {
      margin-left: 250px;
      width: calc(100% - 250px);
      min-height: 100vh;
    }

    .topbar {
      height: 70px;
      background: white;
      border-bottom: 1px solid var(--border);
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 0 32px;
      position: sticky;
      top: 0;
      z-index: 10;
    }

    .breadcrumb {
      color: var(--muted);
      font-size: 14px;
    }

    .breadcrumb strong {
      color: var(--text);
    }

    .top-actions {
      display: flex;
      align-items: center;
      gap: 12px;
    }

    .test-badge {
      padding: 6px 10px;
      border-radius: 999px;
      background: #fff4cc;
      color: #8a5a00;
      font-size: 11px;
      font-weight: 800;
      letter-spacing: .4px;
    }

    .top-button {
      border: 1px solid var(--border);
      background: white;
      color: var(--text);
      border-radius: 7px;
      padding: 8px 12px;
      text-decoration: none;
      font-size: 13px;
    }

    .content {
      max-width: 1400px;
      margin: 0 auto;
      padding: 34px;
    }

    .page-heading {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      margin-bottom: 25px;
      gap: 20px;
    }

    .page-heading h1 {
      margin: 0 0 6px;
      font-size: 28px;
      letter-spacing: -0.6px;
    }

    .page-heading p {
      margin: 0;
      color: var(--muted);
      font-size: 14px;
    }

    .primary-button {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      border: 0;
      background: var(--blue);
      color: white;
      padding: 10px 15px;
      border-radius: 7px;
      text-decoration: none;
      font-size: 13px;
      font-weight: 700;
      cursor: pointer;
    }

    .primary-button:hover {
      background: var(--blue-dark);
    }

    .metrics {
      display: grid;
      grid-template-columns: repeat(4, 1fr);
      gap: 16px;
      margin-bottom: 26px;
    }

    .metric {
      background: white;
      border: 1px solid var(--border);
      border-radius: 9px;
      padding: 20px;
      min-height: 132px;
    }

    .metric-label {
      color: var(--muted);
      font-size: 13px;
      margin-bottom: 11px;
    }

    .metric-value {
      font-size: 27px;
      font-weight: 750;
      letter-spacing: -0.6px;
      margin-bottom: 9px;
    }

    .metric-change {
      font-size: 12px;
      color: var(--muted);
    }

    .metric-change.green {
      color: var(--green);
      font-weight: 600;
    }

    .grid {
      display: grid;
      grid-template-columns: minmax(0, 2fr) minmax(260px, 1fr);
      gap: 20px;
      margin-bottom: 24px;
    }

    .panel {
      background: white;
      border: 1px solid var(--border);
      border-radius: 9px;
      overflow: hidden;
    }

    .panel-header {
      padding: 18px 20px;
      border-bottom: 1px solid var(--border);
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 15px;
    }

    .panel-title {
      font-size: 15px;
      font-weight: 700;
    }

    .panel-subtitle {
      color: var(--muted);
      font-size: 12px;
      margin-top: 3px;
    }

    .activity {
      padding: 6px 20px 15px;
    }

    .activity-item {
      display: flex;
      gap: 12px;
      padding: 14px 0;
      border-bottom: 1px solid #f0f2f5;
    }

    .activity-item:last-child {
      border-bottom: 0;
    }

    .activity-icon {
      width: 34px;
      height: 34px;
      border-radius: 50%;
      background: #edf0ff;
      color: var(--blue);
      display: flex;
      align-items: center;
      justify-content: center;
      font-weight: 800;
      flex-shrink: 0;
    }

    .activity-main {
      flex: 1;
      min-width: 0;
    }

    .activity-title {
      font-size: 13px;
      font-weight: 650;
    }

    .activity-time {
      color: var(--muted);
      font-size: 11px;
      margin-top: 4px;
    }

    .activity-amount {
      font-size: 13px;
      font-weight: 700;
    }

    .quick-links {
      padding: 8px 20px 20px;
    }

    .quick-link {
      display: block;
      padding: 13px 0;
      border-bottom: 1px solid #f0f2f5;
      text-decoration: none;
      font-size: 13px;
    }

    .quick-link:last-child {
      border-bottom: 0;
    }

    .quick-link strong {
      display: block;
      margin-bottom: 3px;
    }

    .quick-link span {
      color: var(--muted);
      font-size: 11px;
    }

    .payments-panel {
      margin-top: 24px;
    }

    .filters {
      display: flex;
      align-items: center;
      gap: 8px;
    }

    .search {
      width: 210px;
      border: 1px solid var(--border);
      border-radius: 7px;
      padding: 9px 11px;
      outline: none;
      font-size: 13px;
    }

    .search:focus {
      border-color: var(--blue);
    }

    .filter {
      border: 1px solid var(--border);
      background: white;
      padding: 9px 11px;
      border-radius: 7px;
      color: var(--text);
      font-size: 13px;
    }

    .table-wrap {
      overflow-x: auto;
    }

    table {
      width: 100%;
      border-collapse: collapse;
      min-width: 780px;
    }

    th {
      background: #fafbfc;
      color: var(--muted);
      font-size: 11px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: .3px;
      text-align: left;
      padding: 12px 20px;
      border-bottom: 1px solid var(--border);
    }

    td {
      padding: 14px 20px;
      border-bottom: 1px solid #f0f2f5;
      font-size: 13px;
    }

    tbody tr {
      cursor: pointer;
    }

    tbody tr:hover {
      background: #fafbff;
    }

    .payment-cell {
      display: flex;
      align-items: center;
      gap: 11px;
    }

    .payment-icon {
      width: 34px;
      height: 34px;
      border-radius: 8px;
      background: #edf0ff;
      color: var(--blue);
      display: flex;
      align-items: center;
      justify-content: center;
      font-weight: 800;
    }

    .payment-cell strong {
      display: block;
      font-size: 12px;
      font-family: monospace;
    }

    .payment-cell span {
      display: block;
      color: var(--muted);
      font-size: 11px;
      margin-top: 4px;
    }

    .status {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 5px 8px;
      border-radius: 999px;
      font-size: 11px;
      font-weight: 700;
      text-transform: capitalize;
    }

    .status-dot {
      width: 6px;
      height: 6px;
      border-radius: 50%;
      background: currentColor;
    }

    .status.success {
      color: #087f5b;
      background: #e7f8f1;
    }

    .status.danger {
      color: #b4234d;
      background: #fff0f3;
    }

    .status.warning {
      color: #996000;
      background: #fff7e0;
    }

    .row-button {
      border: 1px solid var(--border);
      background: white;
      border-radius: 6px;
      padding: 6px 9px;
      font-size: 11px;
      cursor: pointer;
    }

    .empty-state {
      text-align: center;
      padding: 60px 20px;
      color: var(--muted);
    }

    .empty-icon {
      margin: 0 auto 14px;
      width: 50px;
      height: 50px;
      border-radius: 50%;
      background: #edf0ff;
      color: var(--blue);
      display: flex;
      align-items: center;
      justify-content: center;
      font-weight: 800;
      font-size: 20px;
    }

    .empty-state h3 {
      color: var(--text);
      margin: 0 0 5px;
    }

    .empty-state p {
      margin: 0 0 18px;
      font-size: 13px;
    }

    .modal-backdrop {
      display: none;
      position: fixed;
      inset: 0;
      background: rgba(10, 37, 64, .45);
      z-index: 100;
      align-items: center;
      justify-content: center;
      padding: 20px;
    }

    .modal {
      width: 100%;
      max-width: 520px;
      background: white;
      border-radius: 12px;
      overflow: hidden;
      box-shadow: 0 20px 60px rgba(0,0,0,.2);
    }

    .modal-header {
      padding: 20px;
      border-bottom: 1px solid var(--border);
      display: flex;
      justify-content: space-between;
      align-items: center;
    }

    .modal-header h2 {
      margin: 0;
      font-size: 18px;
    }

    .close {
      border: 0;
      background: transparent;
      font-size: 24px;
      color: var(--muted);
      cursor: pointer;
    }

    .modal-body {
      padding: 20px;
    }

    .detail-amount {
      font-size: 32px;
      font-weight: 800;
      margin-bottom: 20px;
    }

    .detail-grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 16px;
    }

    .detail-label {
      color: var(--muted);
      font-size: 11px;
      margin-bottom: 5px;
    }

    .detail-value {
      font-size: 13px;
      font-weight: 600;
      word-break: break-word;
    }

    @media (max-width: 1100px) {
      .metrics {
        grid-template-columns: repeat(2, 1fr);
      }

      .grid {
        grid-template-columns: 1fr;
      }
    }

    @media (max-width: 800px) {
      .sidebar {
        position: static;
        width: 100%;
        min-height: auto;
        padding: 12px;
      }

      .app {
        display: block;
      }

      .brand {
        padding: 8px 10px 14px;
      }

      .workspace {
        display: none;
      }

      .nav-section {
        display: none;
      }

      .nav {
        display: flex;
        overflow-x: auto;
        gap: 4px;
      }

      .nav a {
        white-space: nowrap;
        margin: 0;
      }

      .sidebar-bottom {
        display: none;
      }

      .main {
        margin-left: 0;
        width: 100%;
      }

      .topbar {
        height: auto;
        padding: 14px 18px;
      }

      .content {
        padding: 20px 16px;
      }

      .page-heading {
        flex-direction: column;
      }

      .metrics {
        grid-template-columns: 1fr;
      }

      .filters {
        flex-direction: column;
        align-items: stretch;
      }

      .search {
        width: 100%;
      }

      .filter {
        width: 100%;
      }

      .top-button {
        display: none;
      }
    }
  </style>
</head>

<body>

<div class="app">

  <aside class="sidebar">

    <div class="brand">
      Your<span>Pay</span>
    </div>

    <div class="workspace">
      <div class="workspace-title">YourPay Demo</div>
      Test workspace
    </div>

    <div class="nav-section">Platform</div>

    <nav class="nav">

      <a class="active" href="/dashboard">
        <span class="nav-icon">⌂</span>
        Overview
      </a>

      <a href="/dashboard#payments">
        <span class="nav-icon">↕</span>
        Payments
      </a>

      <a href="/dashboard#customers">
        <span class="nav-icon">♙</span>
        Customers
      </a>

    </nav>

    <div class="nav-section">Developers</div>

    <nav class="nav">

      <a href="/dashboard#api">
        <span class="nav-icon">&lt;/&gt;</span>
        API keys
      </a>

      <a href="/checkout">
        <span class="nav-icon">▣</span>
        Checkout
      </a>

    </nav>

    <div class="sidebar-bottom">

      <div class="mode">
        <strong>● TEST MODE</strong>
        No real money is being moved.
      </div>

    </div>

  </aside>

  <main class="main">

    <header class="topbar">

      <div class="breadcrumb">
        YourPay / <strong>Overview</strong>
      </div>

      <div class="top-actions">

        <span class="test-badge">
          TEST MODE
        </span>

        <a class="top-button" href="/checkout">
          Open checkout
        </a>

      </div>

    </header>

    <div class="content">

      <div class="page-heading">

        <div>
          <h1>Overview</h1>
          <p>Monitor your payments and YourPay activity.</p>
        </div>

        <a href="/checkout" class="primary-button">
          Create test payment
        </a>

      </div>

      <section class="metrics">

        <div class="metric">

          <div class="metric-label">
            Total volume
          </div>

          <div class="metric-value">
            ${money(totalRevenue)}
          </div>

          <div class="metric-change green">
            ↑ Test payment volume
          </div>

        </div>

        <div class="metric">

          <div class="metric-label">
            Successful payments
          </div>

          <div class="metric-value">
            ${successful.length}
          </div>

          <div class="metric-change">
            ${money(successfulRevenue)} processed
          </div>

        </div>

        <div class="metric">

          <div class="metric-label">
            Pending payments
          </div>

          <div class="metric-value">
            ${pending.length}
          </div>

          <div class="metric-change">
            Awaiting confirmation
          </div>

        </div>

        <div class="metric">

          <div class="metric-label">
            Customers
          </div>

          <div class="metric-value">
            ${allCustomers.length}
          </div>

          <div class="metric-change">
            Total customers
          </div>

        </div>

      </section>

      <section class="grid">

        <div class="panel">

          <div class="panel-header">

            <div>
              <div class="panel-title">
                Recent activity
              </div>

              <div class="panel-subtitle">
                Latest payment activity
              </div>
            </div>

          </div>

          <div class="activity">

            ${
              allPayments.length
                ? allPayments
                    .slice(0, 5)
                    .map(
                      payment => `
                        <div class="activity-item">

                          <div class="activity-icon">
                            £
                          </div>

                          <div class="activity-main">

                            <div class="activity-title">
                              ${escapeHtml(payment.description)}
                            </div>

                            <div class="activity-time">
                              ${formatDate(payment.created)}
                            </div>

                          </div>

                          <div class="activity-amount">
                            ${money(payment.amount)}
                          </div>

                        </div>
                      `
                    )
                    .join("")
                : `
                  <div class="empty-state">
                    <p>No activity yet.</p>
                  </div>
                `
            }

          </div>

        </div>

        <div class="panel">

          <div class="panel-header">

            <div>
              <div class="panel-title">
                Quick actions
              </div>

              <div class="panel-subtitle">
                Build with YourPay
              </div>
            </div>

          </div>

          <div class="quick-links">

            <a class="quick-link" href="/checkout">
              <strong>Test checkout</strong>
              <span>Open a hosted YourPay checkout.</span>
            </a>

            <a class="quick-link" href="#api">
              <strong>API keys</strong>
              <span>Create a test API key.</span>
            </a>

            <a class="quick-link" href="#payments">
              <strong>View payments</strong>
              <span>Search and inspect payment history.</span>
            </a>

          </div>

        </div>

      </section>

      <section class="panel payments-panel" id="payments">

        <div class="panel-header">

          <div>
            <div class="panel-title">
              Payments
            </div>

            <div class="panel-subtitle">
              All payment activity
            </div>
          </div>

          <div class="filters">

            <input
              id="search"
              class="search"
              type="search"
              placeholder="Search payments..."
              oninput="filterPayments()"
            >

            <select
              id="statusFilter"
              class="filter"
              onchange="filterPayments()"
            >

              <option value="all">
                All statuses
              </option>

              <option value="succeeded">
                Succeeded
              </option>

              <option value="requires_confirmation">
                Pending
              </option>

              <option value="failed">
                Failed
              </option>

            </select>

          </div>

        </div>

        <div class="table-wrap">

          <table>

            <thead>

              <tr>
                <th>Payment</th>
                <th>Description</th>
                <th>Amount</th>
                <th>Status</th>
                <th></th>
              </tr>

            </thead>

            <tbody id="paymentsBody">

              ${paymentRows || emptyRows}

            </tbody>

          </table>

        </div>

      </section>

      <section class="panel payments-panel" id="customers">

        <div class="panel-header">

          <div>
            <div class="panel-title">
              Customers
            </div>

            <div class="panel-subtitle">
              Persistent customer records
            </div>
          </div>

        </div>

        <div class="table-wrap">

          <table>

            <thead>
              <tr>
                <th>Customer</th>
                <th>Name</th>
                <th>Email</th>
                <th>Created</th>
              </tr>
            </thead>

            <tbody>

              ${
                allCustomers.length
                  ? allCustomers
                      .slice(0, 50)
                      .map(
                        customer => `
                          <tr>

                            <td>
                              <strong style="font-family:monospace;font-size:12px">
                                ${escapeHtml(customer.id)}
                              </strong>
                            </td>

                            <td>
                              ${escapeHtml(customer.name || "—")}
                            </td>

                            <td>
                              ${escapeHtml(customer.email || "—")}
                            </td>

                            <td>
                              ${formatDate(customer.created)}
                            </td>

                          </tr>
                        `
                      )
                      .join("")
                  : `
                    <tr>
                      <td colspan="4">
                        <div class="empty-state">
                          <h3>No customers yet</h3>
                          <p>Create a customer through the YourPay API.</p>
                        </div>
                      </td>
                    </tr>
                  `
              }

            </tbody>

          </table>

        </div>

      </section>

      <section class="panel payments-panel" id="api">

        <div class="panel-header">

          <div>
            <div class="panel-title">
              Developer tools
            </div>

            <div class="panel-subtitle">
              YourPay API
            </div>
          </div>

          <button class="primary-button" onclick="createApiKey()">
            Create test API key
          </button>

        </div>

        <div style="padding:20px">

          <p style="font-size:13px;color:#697386;margin-top:0">
            API keys allow your application to authenticate with YourPay.
          </p>

          <div id="apiResult"></div>

        </div>

      </section>

    </div>

  </main>

</div>

<div id="modalBackdrop" class="modal-backdrop">

  <div class="modal">

    <div class="modal-header">

      <h2>Payment details</h2>

      <button class="close" onclick="closePayment()">
        ×
      </button>

    </div>

    <div id="modalBody" class="modal-body"></div>

  </div>

</div>

<script>

const paymentData = ${JSON.stringify(allPayments)};

function filterPayments() {

  const search =
    document
      .getElementById("search")
      .value
      .toLowerCase();

  const status =
    document
      .getElementById("statusFilter")
      .value;

  const rows =
    document.querySelectorAll(
      "#paymentsBody tr[data-status]"
    );

  rows.forEach(row => {

    const rowStatus =
      row.getAttribute("data-status");

    const rowSearch =
      row.getAttribute("data-search");

    const matchesSearch =
      !search ||
      rowSearch.indexOf(search) !== -1;

    const matchesStatus =
      status === "all" ||
      rowStatus === status;

    row.style.display =
      matchesSearch && matchesStatus
        ? ""
        : "none";

  });

}

function showPayment(id) {

  const payment =
    paymentData.find(
      item => item.id === id
    );

  if (!payment) {
    return;
  }

  const statusClass =
    payment.status === "succeeded"
      ? "success"
      : payment.status === "failed"
      ? "danger"
      : "warning";

  document.getElementById("modalBody").innerHTML = \`
    <div class="detail-amount">
      £\${(Number(payment.amount) / 100).toFixed(2)}
    </div>

    <div style="margin-bottom:20px">
      <span class="status \${statusClass}">
        <span class="status-dot"></span>
        \${payment.status.replace(/_/g, " ")}
      </span>
    </div>

    <div class="detail-grid">

      <div>
        <div class="detail-label">
          PAYMENT ID
        </div>

        <div class="detail-value">
          \${payment.id}
        </div>
      </div>

      <div>
        <div class="detail-label">
          CURRENCY
        </div>

        <div class="detail-value">
          \${String(payment.currency || "").toUpperCase()}
        </div>
      </div>

      <div>
        <div class="detail-label">
          DESCRIPTION
        </div>

        <div class="detail-value">
          \${payment.description || ""}
        </div>
      </div>

      <div>
        <div class="detail-label">
          CREATED
        </div>

        <div class="detail-value">
          \${new Date(payment.created).toLocaleString("en-GB")}
        </div>
      </div>

      <div>
        <div class="detail-label">
          CUSTOMER
        </div>

        <div class="detail-value">
          \${payment.customer || "—"}
        </div>
      </div>

    </div>
  \`;

  document.getElementById("modalBackdrop").style.display =
    "flex";
}

function closePayment() {

  document.getElementById("modalBackdrop").style.display =
    "none";

}

document
  .getElementById("modalBackdrop")
  .addEventListener("click", event => {

    if (event.target.id === "modalBackdrop") {
      closePayment();
    }

  });

async function createApiKey() {

  const result =
    document.getElementById("apiResult");

  result.innerHTML =
    "<p style='font-size:13px'>Creating key...</p>";

  try {

    const response =
      await fetch("/dev/api-keys", {
        method: "POST"
      });

    const data =
      await response.json();

    if (!response.ok) {
      throw new Error(
        data.error || "Could not create API key"
      );
    }

    result.innerHTML = \`
      <div style="
        background:#f6f9fc;
        border:1px solid #e6ebf1;
        border-radius:8px;
        padding:14px;
        font-family:monospace;
        font-size:12px;
        word-break:break-all;
      ">
        \${data.key}
      </div>

      <p style="
        font-size:11px;
        color:#697386;
        margin-bottom:0;
      ">
        Store this test key securely.
      </p>
    \`;

  } catch (error) {

    result.innerHTML =
      "<p style='color:#df1b41'>" +
      escapeHtml(error.message) +
      "</p>";

  }

}

</script>

</body>
</html>
`;
}

function checkoutHtml() {
  return `
<!DOCTYPE html>
<html lang="en">

<head>

  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="theme-color" content="#0a2540">

  <title>YourPay Checkout</title>

  <style>

    * {
      box-sizing: border-box;
    }

    body {
      margin: 0;
      background: #f6f9fc;
      color: #1a1f36;
      font-family:
        -apple-system,
        BlinkMacSystemFont,
        "Segoe UI",
        sans-serif;
      padding: 20px;
    }

    .container {
      width: 100%;
      max-width: 460px;
      margin: 45px auto;
    }

    .top {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 18px;
    }

    .brand {
      color: #0a2540;
      font-size: 24px;
      font-weight: 800;
    }

    .brand span {
      color: #635bff;
    }

    .dashboard {
      color: #697386;
      text-decoration: none;
      font-size: 13px;
    }

    .checkout-box {
      background: white;
      border: 1px solid #e6ebf1;
      border-radius: 12px;
      padding: 28px;
      box-shadow:
        0 8px 30px rgba(10, 37, 64, .05);
    }

    .test-badge {
      display: inline-block;
      background: #fff4cc;
      color: #8a5a00;
      padding: 6px 9px;
      border-radius: 999px;
      font-size: 10px;
      font-weight: 800;
      margin-bottom: 18px;
    }

    h1 {
      margin: 0 0 8px;
      font-size: 25px;
      letter-spacing: -.4px;
    }

    .description {
      color: #697386;
      font-size: 13px;
      margin-bottom: 22px;
    }

    .amount {
      font-size: 36px;
      font-weight: 800;
      margin-bottom: 25px;
    }

    label {
      display: block;
      color: #1a1f36;
      font-size: 12px;
      font-weight: 700;
      margin-bottom: 7px;
    }

    input {
      width: 100%;
      padding: 13px;
      border: 1px solid #cfd7df;
      border-radius: 7px;
      outline: none;
      margin-bottom: 16px;
      font-size: 15px;
    }

    input:focus {
      border-color: #635bff;
      box-shadow: 0 0 0 2px rgba(99,91,255,.1);
    }

    .two {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 12px;
    }

    button {
      width: 100%;
      border: 0;
      border-radius: 7px;
      padding: 14px;
      background: #635bff;
      color: white;
      font-size: 15px;
      font-weight: 750;
      cursor: pointer;
    }

    button:hover {
      background: #4f46e5;
    }

    button:disabled {
      opacity: .6;
    }

    .secure {
      text-align: center;
      color: #8792a2;
      font-size: 11px;
      margin-top: 16px;
    }

    .result {
      display: none;
      margin-top: 17px;
      padding: 14px;
      border-radius: 8px;
      font-size: 13px;
      word-break: break-word;
    }

    .success {
      background: #e7f8f1;
      color: #087f5b;
    }

    .error {
      background: #fff0f3;
      color: #b4234d;
    }

    .test-card {
      margin-top: 18px;
      padding: 12px;
      background: #f6f9fc;
      border: 1px solid #e6ebf1;
      border-radius: 8px;
      color: #697386;
      font-size: 11px;
    }

  </style>

</head>

<body>

  <div class="container">

    <div class="top">

      <div class="brand">
        Your<span>Pay</span>
      </div>

      <a class="dashboard" href="/dashboard">
        Dashboard
      </a>

    </div>

    <div class="checkout-box">

      <div class="test-badge">
        TEST MODE
      </div>

      <h1>
        Test Product
      </h1>

      <div class="description">
        Secure payment powered by YourPay.
      </div>

      <div class="amount">
        £10.00
      </div>

      <form id="payment-form">

        <label>
          Card number
        </label>

        <input
          id="card"
          inputmode="numeric"
          value="4242 4242 4242 4242"
        >

        <div class="two">

          <div>

            <label>
              Expiry
            </label>

            <input
              id="expiry"
              value="12/30"
            >

          </div>

          <div>

            <label>
              CVC
            </label>

            <input
              id="cvc"
              inputmode="numeric"
              value="123"
            >

          </div>

        </div>

        <button
          id="pay-button"
          type="submit"
        >
          Pay £10.00
        </button>

      </form>

      <div
        id="result"
        class="result"
      ></div>

      <div class="secure">
        🔒 Test checkout powered by YourPay
      </div>

      <div class="test-card">
        Test card:
        <strong>4242 4242 4242 4242</strong>
        · 12/30 · 123
      </div>

    </div>

  </div>

  <script>

    const form =
      document.getElementById("payment-form");

    const button =
      document.getElementById("pay-button");

    const result =
      document.getElementById("result");

    form.addEventListener(
      "submit",
      async event => {

        event.preventDefault();

        button.disabled = true;
        button.textContent = "Processing...";

        result.style.display = "none";

        try {

          const response =
            await fetch(
              "/checkout/pay",
              {
                method: "POST",
                headers: {
                  "Content-Type": "application/json"
                },
                body: JSON.stringify({
                  card:
                    document.getElementById("card").value,
                  expiry:
                    document.getElementById("expiry").value,
                  cvc:
                    document.getElementById("cvc").value
                })
              }
            );

          const data =
            await response.json();

          if (!response.ok) {
            throw new Error(
              data.error &&
              data.error.message
                ? data.error.message
                : data.error || "Payment failed"
            );
          }

          result.className =
            "result success";

          result.style.display =
            "block";

          result.innerHTML =
            "<strong>Payment successful</strong><br>" +
            "Payment ID: " +
            data.payment_id;

          button.textContent =
            "Payment complete";

        } catch (error) {

          result.className =
            "result error";

          result.style.display =
            "block";

          result.textContent =
            error.message;

          button.disabled =
            false;

          button.textContent =
            "Pay £10.00";

        }

      }
    );

  </script>

</body>

</html>
`;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(
    req.url,
    "http://localhost"
  );

  const pathname = url.pathname;

  if (
    req.method === "GET" &&
    pathname === "/"
  ) {
    const stats = db.getStats();

    sendJson(res, 200, {
      name: "YourPay",
      version: "1.0.0",
      status: "online",
      database: "persistent",
      stats: {
        payments: stats.payments,
        successful_payments: stats.successfulPayments,
        customers: stats.customers
      }
    });

    return;
  }

  if (
    req.method === "GET" &&
    pathname === "/dashboard"
  ) {
    sendHtml(
      res,
      200,
      dashboardHtml()
    );

    return;
  }

  if (
    req.method === "GET" &&
    pathname === "/checkout"
  ) {
    sendHtml(
      res,
      200,
      checkoutHtml()
    );

    return;
  }

  if (
    req.method === "POST" &&
    pathname === "/dev/api-keys"
  ) {
    const key =
      "yp_test_" +
      crypto.randomBytes(18).toString("hex");

    db.addApiKey({
      key,
      created: new Date().toISOString()
    });

    sendJson(res, 201, {
      key
    });

    return;
  }

  if (
    req.method === "POST" &&
    pathname === "/checkout/pay"
  ) {
    const paymentId =
      makeId("pi");

    const payment = {
      id: paymentId,
      amount: 1000,
      currency: "gbp",
      description: "Test Product",
      status: "succeeded",
      customer: null,
      created: new Date().toISOString()
    };

    db.addPayment(payment);

    sendJson(res, 200, {
      success: true,
      payment_id: paymentId,
      status: payment.status,
      amount: payment.amount,
      currency: payment.currency
    });

    return;
  }

  if (
    req.method === "POST" &&
    pathname === "/v1/customers"
  ) {
    if (!requireApiKey(req, res)) {
      return;
    }

    try {
      const body =
        await parseBody(req);

      const email =
        body.email || null;

      const name =
        body.name || null;

      const id =
        makeId("cus");

      const customer = {
        id,
        email,
        name,
        created:
          new Date().toISOString()
      };

      db.addCustomer(customer);

      sendJson(
        res,
        201,
        customer
      );

    } catch (error) {
      sendJson(res, 400, {
        error: {
          type: "invalid_request_error",
          message: "Invalid JSON."
        }
      });
    }

    return;
  }

  if (
    req.method === "POST" &&
    pathname === "/v1/payment_intents"
  ) {
    if (!requireApiKey(req, res)) {
      return;
    }

    try {
      const body =
        await parseBody(req);

      const amount =
        Number(body.amount);

      if (
        !Number.isInteger(amount) ||
        amount <= 0
      ) {
        sendJson(res, 400, {
          error: {
            type: "invalid_request_error",
            message:
              "amount must be a positive integer representing the smallest currency unit."
          }
        });

        return;
      }

      const currency =
        String(
          body.currency || "gbp"
        ).toLowerCase();

      const customerId =
        body.customer || null;

      if (customerId) {
        const customer =
          db.getCustomer(customerId);

        if (!customer) {
          sendJson(res, 400, {
            error: {
              type: "invalid_request_error",
              message:
                "Customer does not exist."
            }
          });

          return;
        }
      }

      const id =
        makeId("pi");

      const payment = {
        id,
        amount,
        currency,
        description:
          body.description ||
          "YourPay payment",
        customer:
          customerId,
        status:
          "requires_confirmation",
        created:
          new Date().toISOString()
      };

      db.addPayment(payment);

      sendJson(
        res,
        201,
        payment
      );

    } catch (error) {
      sendJson(res, 400, {
        error: {
          type: "invalid_request_error",
          message: "Invalid JSON."
        }
      });
    }

    return;
  }

  const paymentMatch =
    pathname.match(
      /^\/v1\/payment_intents\/([^/]+)$/
    );

  if (
    req.method === "GET" &&
    paymentMatch
  ) {
    if (!requireApiKey(req, res)) {
      return;
    }

    const payment =
      db.getPayment(
        paymentMatch[1]
      );

    if (!payment) {
      sendJson(res, 404, {
        error: {
          type: "resource_missing",
          message:
            "Payment intent not found."
        }
      });

      return;
    }

    sendJson(
      res,
      200,
      payment
    );

    return;
  }

  const confirmMatch =
    pathname.match(
      /^\/v1\/payment_intents\/([^/]+)\/confirm$/
    );

  if (
    req.method === "POST" &&
    confirmMatch
  ) {
    if (!requireApiKey(req, res)) {
      return;
    }

    const payment =
      db.getPayment(
        confirmMatch[1]
      );

    if (!payment) {
      sendJson(res, 404, {
        error: {
          type: "resource_missing",
          message:
            "Payment intent not found."
        }
      });

      return;
    }

    if (
      payment.status === "succeeded"
    ) {
      sendJson(
        res,
        200,
        payment
      );

      return;
    }

    const updated =
      db.updatePayment(
        payment.id,
        {
          status: "succeeded",
          confirmed_at:
            new Date().toISOString()
        }
      );

    sendJson(
      res,
      200,
      updated
    );

    return;
  }

  sendJson(res, 404, {
    error: {
      type: "invalid_request_error",
      message: "Not found."
    }
  });
});

server.on("error", error => {
  console.error(
    "YourPay server error:",
    error.message
  );
});

server.listen(
  PORT,
  () => {
    console.log(
      "YourPay running at http://localhost:" +
      PORT
    );

    console.log(
      "Persistent database: data/database.json"
    );

    const stats =
      db.getStats();

    console.log(
      "Payments:",
      stats.payments
    );

    console.log(
      "Customers:",
      stats.customers
    );
  }
);