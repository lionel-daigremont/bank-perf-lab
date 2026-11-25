// SMOKE: 1 user, every endpoint, every business rule. Run it first (and in CI):
// if this fails, a load test would only measure errors.
//   k6 run k6/smoke.js
import { check, group, sleep } from 'k6';
import {
  login, resetBank, getAccount, getTransactions, createPayment, getPayment,
  newIdempotencyKey, checkReconciliation,
} from './lib/api.js';
import http from 'k6/http';

export const options = {
  vus: 1,
  iterations: 5,
  thresholds: {
    checks: ['rate==1'],
    reconciliation_errors: ['count==0'],
    http_req_duration: ['p(95)<500'],
  },
};

// 401 and 422 are expected answers in this script, not failures.
http.setResponseCallback(http.expectedStatuses(200, 201, 401, 422));

export function setup() {
  resetBank();
  return { token: login() };
}

export default function ({ token }) {
  const from = 'ACC-0001';
  const to = 'ACC-0002';

  group('accounts', () => {
    check(getAccount(token, from), {
      'balance: 200': (r) => r.status === 200,
      'balance: PEN amount': (r) => r.json('currency') === 'PEN' && !isNaN(Number(r.json('balance'))),
    });
    check(getTransactions(token, from), { 'history: 200': (r) => r.status === 200 });
    check(getAccount('not-a-token', from), { 'no token: 401': (r) => r.status === 401 });
  });

  group('payment + idempotent retry', () => {
    const key = newIdempotencyKey('smoke');
    const first = createPayment(token, { from, to, amount: '10.00' }, key);
    check(first, {
      'payment: 201': (r) => r.status === 201,
      'payment: PENDING': (r) => r.json('status') === 'PENDING',
    });
    // Same key, same body: the client retried (timeout, network glitch...). No second debit.
    const retry = createPayment(token, { from, to, amount: '10.00' }, key);
    check(retry, {
      'retry: same payment returned': (r) => r.json('id') === first.json('id'),
      'retry: flagged as replay': (r) => r.headers['Idempotent-Replayed'] === 'true',
    });
    // Same key, different body: a client bug, must be refused.
    check(createPayment(token, { from, to, amount: '99.00' }, key), {
      'key reused with other body: 422': (r) => r.status === 422,
    });
    sleep(0.5); // settlement is asynchronous
    check(getPayment(token, first.json('id')), { 'payment settled': (r) => r.json('status') === 'SETTLED' });
  });

  group('business rules', () => {
    check(createPayment(token, { from, to, amount: '99999999' }), {
      'insufficient funds: 422': (r) => r.status === 422 && r.json('code') === 'INSUFFICIENT_FUNDS',
    });
  });
}

export function teardown() {
  checkReconciliation();
}
