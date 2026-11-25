// Realistic traffic mix for a retail banking app, shared by load / stress / spike / soak.
// Most users only look at their balance; fewer check history; fewer still pay.
import { check } from 'k6';
import { getAccount, getTransactions, createPayment, randomAccount } from './api.js';

export const MIX = { balance: 0.6, history: 0.25, payment: 0.15 };

export function bankingUser(token) {
  const me = randomAccount();
  const dice = Math.random();

  if (dice < MIX.balance) {
    const res = getAccount(token, me);
    check(res, { 'balance: 200': (r) => r.status === 200 });
  } else if (dice < MIX.balance + MIX.history) {
    const res = getTransactions(token, me);
    check(res, { 'history: 200': (r) => r.status === 200 });
  } else {
    makePayment(token, me);
  }
}

export function makePayment(token, from = randomAccount()) {
  let to = randomAccount();
  while (to === from) to = randomAccount();
  const amount = (1 + Math.random() * 49).toFixed(2); // 1 to 50 PEN: never "insufficient funds"
  const res = createPayment(token, { from, to, amount });
  check(res, { 'payment: 201': (r) => r.status === 201 });
  return res;
}

// Standard thresholds, per endpoint thanks to the `name` tag.
export const ENDPOINT_THRESHOLDS = {
  'http_req_duration{name:GET /accounts/:id}': ['p(95)<300'],
  'http_req_duration{name:GET /accounts/:id/transactions}': ['p(95)<300'],
  'http_req_duration{name:POST /payments}': ['p(95)<500', 'p(99)<1000'],
  http_req_failed: ['rate<0.01'],
  checks: ['rate>0.99'],
  reconciliation_errors: ['count==0'],
};
