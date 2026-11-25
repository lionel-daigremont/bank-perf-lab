// STRESS: raise the arrival rate step by step until the API breaks.
// Question answered: where is the breaking point, and how does the system fail?
// The test aborts as soon as errors or latency go too far: the last stage reached
// (printed in the summary) is the capacity of the system.
//   k6 run k6/stress.js
//   k6 run -e SHORT=1 k6/stress.js
import { login, resetBank, checkReconciliation, SHORT } from './lib/api.js';
import { bankingUser } from './lib/traffic.js';

const STEP = SHORT ? '20s' : '2m';

export const options = {
  scenarios: {
    staircase: {
      executor: 'ramping-arrival-rate',
      startRate: 50,
      timeUnit: '1s',
      preAllocatedVUs: 100,
      maxVUs: 1500,
      stages: [
        { target: 100, duration: STEP }, { target: 100, duration: STEP },
        { target: 200, duration: STEP }, { target: 200, duration: STEP },
        { target: 400, duration: STEP }, { target: 400, duration: STEP },
        { target: 600, duration: STEP }, { target: 600, duration: STEP },
        { target: 800, duration: STEP }, { target: 800, duration: STEP },
      ],
    },
  },
  thresholds: {
    // abortOnFail turns these SLOs into a "breaking point detector"
    http_req_failed: [{ threshold: 'rate<0.05', abortOnFail: true, delayAbortEval: '10s' }],
    http_req_duration: [{ threshold: 'p(95)<1500', abortOnFail: true, delayAbortEval: '10s' }],
    reconciliation_errors: ['count==0'], // even when overloaded, money must stay consistent
  },
};

export function setup() {
  resetBank();
  return { token: login() };
}

export default function ({ token }) {
  bankingUser(token);
}

export function teardown() {
  checkReconciliation();
}
