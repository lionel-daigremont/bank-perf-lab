// CONCURRENCY / CORRECTNESS UNDER LOAD
// Performance tests usually measure speed. In payments, the most expensive bugs
// appear under concurrency: double debits, lost updates, overdrafts.
//
// Scenario 1 - duplicate_submissions: 50 VUs send the SAME payment with the SAME
//   Idempotency-Key at the same moment (a mobile app retrying after a timeout,
//   a user double-tapping "Pay"). Expected: exactly one payment per key.
// Scenario 2 - overdraft_race: 100 payments of 200 PEN hit one account holding
//   10,000 PEN at the same moment. Expected: exactly 50 accepted, 50 refused
//   (INSUFFICIENT_FUNDS), final balance 0, never negative.
//
//   k6 run k6/concurrency.js                         -> passes
//   node mock-bank/server.js --bug=race, then rerun  -> must FAIL
import http from 'k6/http';
import { check } from 'k6';
import { Counter } from 'k6/metrics';
import { login, resetBank, createPayment, getAccount, checkReconciliation } from './lib/api.js';

const ROUNDS = 5;
const created = new Counter('duplicate_round_payments_created');
const accepted = new Counter('overdraft_payments_accepted');
const refused = new Counter('overdraft_payments_refused');

export const options = {
  scenarios: {
    duplicate_submissions: {
      executor: 'per-vu-iterations',
      vus: 50, iterations: ROUNDS, maxDuration: '1m',
      exec: 'duplicateSubmission',
    },
    overdraft_race: {
      executor: 'per-vu-iterations',
      vus: 100, iterations: 1, maxDuration: '1m',
      startTime: '15s',
      exec: 'overdraftRace',
    },
  },
  thresholds: {
    checks: ['rate==1'],
    duplicate_round_payments_created: [`count==${ROUNDS}`], // one payment per key, no more
    overdraft_payments_accepted: ['count==50'],             // 10,000 / 200
    overdraft_payments_refused: ['count==50'],
    reconciliation_errors: ['count==0'],
  },
};

// 409 (in progress) and 422 (insufficient funds) are correct answers here.
http.setResponseCallback(http.expectedStatuses(200, 201, 409, 422));

export function setup() {
  resetBank();
  return { token: login(), runId: Date.now() };
}

export function duplicateSubmission({ token, runId }) {
  // Every VU uses the key of the current round: 50 concurrent requests per key.
  const key = `dup-${runId}-${__ITER}`;
  const res = createPayment(token, { from: 'ACC-0100', to: 'ACC-0101', amount: '25.00' }, key);
  check(res, { 'duplicate: 201, replay or 409': (r) => [200, 201, 409].includes(r.status) });
  if (res.status === 201 && res.headers['Idempotent-Replayed'] !== 'true') created.add(1);
}

export function overdraftRace({ token }) {
  const res = createPayment(token, { from: 'ACC-0001', to: 'ACC-0002', amount: '200.00' });
  check(res, { 'overdraft: 201 or INSUFFICIENT_FUNDS': (r) => r.status === 201 || r.json('code') === 'INSUFFICIENT_FUNDS' });
  if (res.status === 201) accepted.add(1);
  else refused.add(1);
}

export function teardown({ token }) {
  checkReconciliation();
  const balance = Number(getAccount(token, 'ACC-0001').json('balance'));
  console.log(`ACC-0001 final balance: ${balance}`);
  check(balance, { 'ACC-0001 ends at exactly 0.00': (b) => b === 0 });
}
