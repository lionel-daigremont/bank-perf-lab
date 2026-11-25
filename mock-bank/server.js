// Mock banking API used as the system under test.
// Zero dependencies: `node mock-bank/server.js` (Node 18+).
//
// What it simulates:
// - OAuth-like token endpoint, Bearer auth on every business endpoint
// - accounts with balances, transaction history
// - payments with an Idempotency-Key header (safe retries)
// - an asynchronous settlement queue (payments are debited at once, credited later)
// - a limited "database connection pool" that saturates under load (-> latency, then 503)
// - Prometheus metrics on /metrics, a reconciliation report on /admin/reconciliation
//
// Fault injection (to prove the tests catch real defects):
//   --bug=race   check-then-act race on balances and idempotency keys (lost updates, duplicates)
//   --bug=leak   idempotency keys are never purged and every request is kept in memory
//   (or BUG=race,leak as an environment variable)
'use strict';
const http = require('http');
const crypto = require('crypto');

// ---------------------------------------------------------------- configuration
const argBug = (process.argv.find((a) => a.startsWith('--bug=')) || '').split('=')[1];
const bugs = new Set((argBug || process.env.BUG || '').split(',').filter(Boolean));
const num = (name, def) => Number(process.env[name] || def);

const cfg = {
  port: num('PORT', 3001),
  accounts: num('ACCOUNTS', 1000),
  initialBalanceCents: num('INITIAL_BALANCE', 10000) * 100, // 10,000.00 PEN per account
  poolSize: num('POOL_SIZE', 10),           // simulated DB connections
  dbLatencyMs: num('DB_LATENCY_MS', 20),    // average time a query holds a connection
  poolTimeoutMs: num('POOL_TIMEOUT_MS', 2000), // waiting longer than this -> 503
  settleRate: num('SETTLE_RATE', 200),      // payments settled per second
  tokenTtlS: num('TOKEN_TTL_S', 3600),
  idempotencyTtlS: num('IDEMPOTENCY_TTL_S', 600),
  clientId: process.env.CLIENT_ID || 'k6-client',
  clientSecret: process.env.CLIENT_SECRET || 's3cr3t',
  bugRace: bugs.has('race'),
  bugLeak: bugs.has('leak'),
};

// ---------------------------------------------------------------- state
let accounts, payments, idempotency, settlementQueue, tokens, leakBucket, nextPaymentId;
const metrics = {
  httpRequests: new Map(), // "route|status" -> count
  paymentsCreated: 0,
  paymentsSettled: 0,
  paymentsRejected: new Map(), // reason -> count
  idempotentReplays: 0,
  poolTimeouts: 0,
};

function accountId(i) {
  return `ACC-${String(i).padStart(4, '0')}`;
}

function reset() {
  accounts = new Map();
  for (let i = 1; i <= cfg.accounts; i++) {
    accounts.set(accountId(i), { id: accountId(i), currency: 'PEN', balance: cfg.initialBalanceCents, history: [] });
  }
  payments = new Map();
  idempotency = new Map(); // key -> { hash, state: 'IN_PROGRESS'|'DONE', status, body, createdAt }
  settlementQueue = [];
  tokens = new Map();
  leakBucket = [];
  nextPaymentId = 1;
}
reset();

// ---------------------------------------------------------------- simulated DB pool
let poolBusy = 0;
const poolWaiters = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function acquire() {
  if (poolBusy < cfg.poolSize) {
    poolBusy++;
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    const waiter = { resolve };
    waiter.timer = setTimeout(() => {
      poolWaiters.splice(poolWaiters.indexOf(waiter), 1);
      metrics.poolTimeouts++;
      reject(Object.assign(new Error('DB pool exhausted'), { code: 'POOL_TIMEOUT' }));
    }, cfg.poolTimeoutMs);
    poolWaiters.push(waiter);
  });
}

function release() {
  const next = poolWaiters.shift();
  if (next) {
    clearTimeout(next.timer);
    next.resolve(); // hand the connection over directly
  } else {
    poolBusy--;
  }
}

// Runs fn while holding a "connection". Latency is random around dbLatencyMs.
async function db(fn) {
  await acquire();
  try {
    await sleep(cfg.dbLatencyMs * (0.5 + Math.random()));
    return fn();
  } finally {
    release();
  }
}

// ---------------------------------------------------------------- settlement worker
// Credits destination accounts at a limited rate, like a clearing system.
setInterval(() => {
  const batch = Math.max(1, Math.round(cfg.settleRate / 10));
  for (let i = 0; i < batch && settlementQueue.length; i++) {
    const p = settlementQueue.shift();
    const to = accounts.get(p.to);
    to.balance += p.amountCents;
    pushHistory(to, { type: 'CREDIT', paymentId: p.id, amountCents: p.amountCents });
    p.status = 'SETTLED';
    p.settledAt = new Date().toISOString();
    metrics.paymentsSettled++;
  }
}, 100);

// Idempotency keys expire (unless the leak bug is on).
setInterval(() => {
  if (cfg.bugLeak) return;
  const limit = Date.now() - cfg.idempotencyTtlS * 1000;
  for (const [key, entry] of idempotency) if (entry.createdAt < limit) idempotency.delete(key);
}, 10000);

function pushHistory(account, entry) {
  account.history.push({ ...entry, at: new Date().toISOString() });
  if (account.history.length > 50) account.history.shift();
}

// ---------------------------------------------------------------- helpers
function send(res, status, body, headers = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
  res.end(JSON.stringify(body));
}
const error = (res, status, code, message) => send(res, status, { code, message });

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', () => {
      if (!data) return resolve({});
      try {
        resolve(JSON.parse(data));
      } catch {
        reject(Object.assign(new Error('invalid JSON'), { code: 'BAD_JSON' }));
      }
    });
  });
}

function authenticated(req) {
  const m = /^Bearer (.+)$/.exec(req.headers.authorization || '');
  if (!m) return false;
  const exp = tokens.get(m[1]);
  return exp !== undefined && exp > Date.now();
}

const reject = (reason) => metrics.paymentsRejected.set(reason, (metrics.paymentsRejected.get(reason) || 0) + 1);
const fmt = (cents) => (cents / 100).toFixed(2);
const paymentView = (p) => ({
  id: p.id, from: p.from, to: p.to, amount: fmt(p.amountCents), currency: 'PEN',
  status: p.status, idempotencyKey: p.idempotencyKey, createdAt: p.createdAt, settledAt: p.settledAt || null,
});

// ---------------------------------------------------------------- handlers
async function createToken(req, res) {
  const body = await readBody(req);
  if (body.client_id !== cfg.clientId || body.client_secret !== cfg.clientSecret) {
    return error(res, 401, 'INVALID_CLIENT', 'Unknown client or wrong secret');
  }
  const token = crypto.randomBytes(16).toString('hex');
  tokens.set(token, Date.now() + cfg.tokenTtlS * 1000);
  send(res, 200, { access_token: token, token_type: 'Bearer', expires_in: cfg.tokenTtlS });
}

async function getAccount(res, id) {
  const acc = await db(() => accounts.get(id));
  if (!acc) return error(res, 404, 'ACCOUNT_NOT_FOUND', `No account ${id}`);
  send(res, 200, { id: acc.id, currency: acc.currency, balance: fmt(acc.balance) });
}

async function getTransactions(res, id, limit) {
  const acc = await db(() => accounts.get(id));
  if (!acc) return error(res, 404, 'ACCOUNT_NOT_FOUND', `No account ${id}`);
  send(res, 200, { accountId: id, transactions: acc.history.slice(-limit).reverse() });
}

async function getPayment(res, id) {
  const p = await db(() => payments.get(id));
  if (!p) return error(res, 404, 'PAYMENT_NOT_FOUND', `No payment ${id}`);
  send(res, 200, paymentView(p));
}

async function createPayment(req, res) {
  const key = req.headers['idempotency-key'];
  if (!key) return error(res, 400, 'IDEMPOTENCY_KEY_REQUIRED', 'Header Idempotency-Key is required');

  const body = await readBody(req);
  const amountCents = Math.round(Number(body.amount) * 100);
  if (!body.from || !body.to || body.from === body.to || !(amountCents > 0) || (body.currency && body.currency !== 'PEN')) {
    reject('VALIDATION');
    return error(res, 400, 'VALIDATION_ERROR', 'from, to (different), amount > 0 and currency PEN are required');
  }
  const hash = crypto.createHash('sha256').update(JSON.stringify([body.from, body.to, amountCents])).digest('hex');

  if (cfg.bugLeak) leakBucket.push({ key, body, headers: req.headers, padding: Buffer.alloc(16384) });

  // --- Idempotency check. Correct version: decided synchronously, before any await,
  //     so two concurrent requests can never both pass it.
  //     Buggy version: the key is looked up, then saved only after another DB round trip,
  //     so concurrent requests all see "unknown key" (check-then-act race).
  const existing = idempotency.get(key);
  if (existing) {
    if (existing.hash !== hash) {
      reject('IDEMPOTENCY_MISMATCH');
      return error(res, 422, 'IDEMPOTENCY_KEY_REUSED', 'This key was already used with a different payload');
    }
    if (existing.state === 'IN_PROGRESS') {
      return error(res, 409, 'REQUEST_IN_PROGRESS', 'A request with this key is being processed, retry later');
    }
    metrics.idempotentReplays++;
    return send(res, existing.status, existing.body, { 'Idempotent-Replayed': 'true' });
  }
  const entry = { hash, state: 'IN_PROGRESS', createdAt: Date.now() };
  if (cfg.bugRace) await db(() => null); // the gap between "check" and "act"
  idempotency.set(key, entry);

  let result;
  try {
    result = cfg.bugRace ? await debitRacy(body, amountCents) : await debitAtomic(body, amountCents);
  } catch (e) {
    idempotency.delete(key); // nothing happened: the client may retry with the same key
    throw e;
  }
  if (result.error) {
    reject(result.error.code);
    Object.assign(entry, { state: 'DONE', status: result.error.status, body: result.error });
    return send(res, result.error.status, result.error);
  }

  const p = {
    id: `PAY-${nextPaymentId++}`, from: body.from, to: body.to, amountCents,
    status: 'PENDING', idempotencyKey: key, createdAt: new Date().toISOString(),
  };
  payments.set(p.id, p);
  settlementQueue.push(p);
  metrics.paymentsCreated++;
  pushHistory(accounts.get(body.from), { type: 'DEBIT', paymentId: p.id, amountCents });
  Object.assign(entry, { state: 'DONE', status: 201, body: paymentView(p) });
  send(res, 201, paymentView(p), { Location: `/payments/${p.id}` });
}

const notFound = (id) => ({ status: 404, code: 'ACCOUNT_NOT_FOUND', message: `No account ${id}` });
const insufficient = { status: 422, code: 'INSUFFICIENT_FUNDS', message: 'Balance too low for this payment' };

// Correct: read, check and write in the same synchronous block (one "transaction").
function debitAtomic(body, amountCents) {
  return db(() => {
    const from = accounts.get(body.from);
    const to = accounts.get(body.to);
    if (!from) return { error: notFound(body.from) };
    if (!to) return { error: notFound(body.to) };
    if (from.balance < amountCents) return { error: insufficient };
    from.balance -= amountCents;
    return {};
  });
}

// Buggy: read the balance, then write it back after another round trip (lost update).
async function debitRacy(body, amountCents) {
  const snapshot = await db(() => {
    const from = accounts.get(body.from);
    return from && accounts.get(body.to) ? from.balance : null;
  });
  if (snapshot === null) return { error: notFound(accounts.get(body.from) ? body.to : body.from) };
  if (snapshot < amountCents) return { error: insufficient };
  await db(() => {
    accounts.get(body.from).balance = snapshot - amountCents;
  });
  return {};
}

function reconciliation() {
  let total = 0;
  let negative = 0;
  for (const a of accounts.values()) {
    total += a.balance;
    if (a.balance < 0) negative++;
  }
  const inFlight = settlementQueue.reduce((s, p) => s + p.amountCents, 0);
  const expected = cfg.accounts * cfg.initialBalanceCents;
  const perKey = new Map();
  for (const p of payments.values()) perKey.set(p.idempotencyKey, (perKey.get(p.idempotencyKey) || 0) + 1);
  const duplicates = [...perKey.values()].filter((n) => n > 1).length;
  return {
    expectedTotal: fmt(expected),
    actualTotal: fmt(total + inFlight),
    driftCents: total + inFlight - expected,
    pendingSettlements: settlementQueue.length,
    negativeBalances: negative,
    duplicatePayments: duplicates,
    consistent: total + inFlight === expected && negative === 0 && duplicates === 0,
  };
}

function prometheus() {
  const r = reconciliation();
  const lines = [
    '# HELP bank_settlement_queue_depth Payments debited but not yet credited',
    '# TYPE bank_settlement_queue_depth gauge',
    `bank_settlement_queue_depth ${settlementQueue.length}`,
    '# TYPE bank_payments_created_total counter',
    `bank_payments_created_total ${metrics.paymentsCreated}`,
    '# TYPE bank_payments_settled_total counter',
    `bank_payments_settled_total ${metrics.paymentsSettled}`,
    '# TYPE bank_payments_rejected_total counter',
    ...[...metrics.paymentsRejected].map(([reason, n]) => `bank_payments_rejected_total{reason="${reason}"} ${n}`),
    '# TYPE bank_idempotent_replays_total counter',
    `bank_idempotent_replays_total ${metrics.idempotentReplays}`,
    '# TYPE bank_db_pool_in_use gauge',
    `bank_db_pool_in_use ${poolBusy}`,
    '# TYPE bank_db_pool_waiting gauge',
    `bank_db_pool_waiting ${poolWaiters.length}`,
    '# TYPE bank_db_pool_timeouts_total counter',
    `bank_db_pool_timeouts_total ${metrics.poolTimeouts}`,
    '# HELP bank_money_drift_cents Money created or destroyed (must stay 0)',
    '# TYPE bank_money_drift_cents gauge',
    `bank_money_drift_cents ${r.driftCents}`,
    '# TYPE bank_idempotency_keys gauge',
    `bank_idempotency_keys ${idempotency.size}`,
    '# TYPE bank_http_requests_total counter',
    ...[...metrics.httpRequests].map(([k, n]) => {
      const [route, status] = k.split('|');
      return `bank_http_requests_total{route="${route}",status="${status}"} ${n}`;
    }),
    '# TYPE process_resident_memory_bytes gauge',
    `process_resident_memory_bytes ${process.memoryUsage().rss}`,
    '',
  ];
  return lines.join('\n');
}

// ---------------------------------------------------------------- router
const routes = [
  ['POST', /^\/auth\/token$/, 'POST /auth/token', (req, res) => createToken(req, res), false],
  ['GET', /^\/accounts\/([\w-]+)$/, 'GET /accounts/:id', (req, res, m) => getAccount(res, m[1]), true],
  ['GET', /^\/accounts\/([\w-]+)\/transactions$/, 'GET /accounts/:id/transactions',
    (req, res, m, url) => getTransactions(res, m[1], Math.min(Number(url.searchParams.get('limit')) || 20, 50)), true],
  ['POST', /^\/payments$/, 'POST /payments', (req, res) => createPayment(req, res), true],
  ['GET', /^\/payments\/([\w-]+)$/, 'GET /payments/:id', (req, res, m) => getPayment(res, m[1]), true],
  ['GET', /^\/admin\/reconciliation$/, 'GET /admin/reconciliation', (req, res) => send(res, 200, reconciliation()), false],
  ['POST', /^\/admin\/reset$/, 'POST /admin/reset', (req, res) => { reset(); send(res, 200, { reset: true }); }, false],
  ['GET', /^\/health$/, 'GET /health', (req, res) => send(res, 200, { status: 'UP', bugs: [...bugs] }), false],
];

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (req.method === 'GET' && url.pathname === '/metrics') {
    res.writeHead(200, { 'Content-Type': 'text/plain; version=0.0.4' });
    return res.end(prometheus());
  }
  let label = 'unknown';
  res.on('finish', () => {
    const k = `${label}|${res.statusCode}`;
    metrics.httpRequests.set(k, (metrics.httpRequests.get(k) || 0) + 1);
  });
  try {
    for (const [method, re, name, handler, needsAuth] of routes) {
      const m = re.exec(url.pathname);
      if (!m || req.method !== method) continue;
      label = name;
      if (needsAuth && !authenticated(req)) return error(res, 401, 'UNAUTHORIZED', 'Missing, invalid or expired token');
      return await handler(req, res, m, url);
    }
    error(res, 404, 'NOT_FOUND', `${req.method} ${url.pathname}`);
  } catch (e) {
    if (e.code === 'POOL_TIMEOUT') return error(res, 503, 'SERVICE_UNAVAILABLE', 'Database pool exhausted');
    if (e.code === 'BAD_JSON') return error(res, 400, 'BAD_JSON', 'Body is not valid JSON');
    console.error(e);
    error(res, 500, 'INTERNAL_ERROR', 'Unexpected error');
  }
});
server.keepAliveTimeout = 65000; // longer than client idle gaps (see the k6-cft lesson)

server.listen(cfg.port, () => {
  const capacity = Math.round((cfg.poolSize * 1000) / cfg.dbLatencyMs);
  console.log(`Mock bank API on http://localhost:${cfg.port}`);
  console.log(`  ${cfg.accounts} accounts, DB pool ${cfg.poolSize} x ~${cfg.dbLatencyMs} ms (~${capacity} queries/s), settlement ${cfg.settleRate}/s`);
  console.log(`  bugs: ${bugs.size ? [...bugs].join(', ') : 'none'}`);
});
