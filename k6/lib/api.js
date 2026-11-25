// Thin client for the mock bank API. Every request carries a `name` tag so that
// thresholds and dashboards can be split per endpoint (otherwise /accounts/ACC-0042
// would create one time series per account).
import http from 'k6/http';
import { check, sleep } from 'k6';
import { Counter } from 'k6/metrics';

export const BASE_URL = __ENV.BASE_URL || 'http://localhost:3001';
export const ACCOUNTS = Number(__ENV.ACCOUNTS || 1000);
export const SHORT = __ENV.SHORT === '1'; // shorter profiles for demos and CI

const JSON_HEADERS = { 'Content-Type': 'application/json' };

export function login() {
  const res = http.post(
    `${BASE_URL}/auth/token`,
    JSON.stringify({ client_id: __ENV.CLIENT_ID || 'k6-client', client_secret: __ENV.CLIENT_SECRET || 's3cr3t' }),
    { headers: JSON_HEADERS, tags: { name: 'POST /auth/token' } },
  );
  if (!check(res, { 'login: 200': (r) => r.status === 200 })) {
    throw new Error(`Login failed (${res.status}): is the mock bank running on ${BASE_URL}?`);
  }
  return res.json('access_token');
}

const auth = (token, extra = {}) => ({ Authorization: `Bearer ${token}`, ...JSON_HEADERS, ...extra });

export function accountId(i) {
  return `ACC-${String(i).padStart(4, '0')}`;
}

export function randomAccount(min = 1, max = ACCOUNTS) {
  return accountId(min + Math.floor(Math.random() * (max - min + 1)));
}

// Unique enough for a test run; k6 has no built-in UUID without remote imports.
export function newIdempotencyKey(prefix = 'k6') {
  return `${prefix}-${__VU}-${__ITER}-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
}

export function getAccount(token, id) {
  return http.get(`${BASE_URL}/accounts/${id}`, { headers: auth(token), tags: { name: 'GET /accounts/:id' } });
}

export function getTransactions(token, id, limit = 20) {
  return http.get(`${BASE_URL}/accounts/${id}/transactions?limit=${limit}`, {
    headers: auth(token),
    tags: { name: 'GET /accounts/:id/transactions' },
  });
}

export function createPayment(token, { from, to, amount }, key = newIdempotencyKey()) {
  return http.post(`${BASE_URL}/payments`, JSON.stringify({ from, to, amount, currency: 'PEN' }), {
    headers: auth(token, { 'Idempotency-Key': key }),
    tags: { name: 'POST /payments' },
  });
}

export function getPayment(token, id) {
  return http.get(`${BASE_URL}/payments/${id}`, { headers: auth(token), tags: { name: 'GET /payments/:id' } });
}

export function resetBank() {
  const res = http.post(`${BASE_URL}/admin/reset`, null, { tags: { name: 'POST /admin/reset' } });
  check(res, { 'reset: 200': (r) => r.status === 200 });
}

// ------------------------------------------------------------------ reconciliation
// Business invariant checked at the end of every test: money is neither created nor
// destroyed, no account is overdrawn, and one idempotency key = at most one payment.
export const reconciliationErrors = new Counter('reconciliation_errors');

export function checkReconciliation(timeoutSec = 50) {
  let report;
  for (let waited = 0; waited <= timeoutSec; waited++) {
    report = http.get(`${BASE_URL}/admin/reconciliation`, { tags: { name: 'GET /admin/reconciliation' } }).json();
    if (report.pendingSettlements === 0) break; // wait for the settlement queue to drain
    sleep(1);
  }
  console.log(`Reconciliation: ${JSON.stringify(report)}`);
  const ok = check(report, {
    'reconciliation: settlement queue drained': (r) => r.pendingSettlements === 0,
    'reconciliation: money conserved (drift = 0)': (r) => r.driftCents === 0,
    'reconciliation: no negative balance': (r) => r.negativeBalances === 0,
    'reconciliation: no duplicate payment': (r) => r.duplicatePayments === 0,
  });
  reconciliationErrors.add(ok ? 0 : 1);
}
