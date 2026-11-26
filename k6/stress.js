// STRESS: raise the arrival rate step by step until the API breaks.
// Question answered: where is the breaking point, and how does the system fail?
// The test aborts as soon as errors or latency go too far: the last stage reached
// (printed in the summary) is the capacity of the system.
//   k6 run k6/stress.js
//   k6 run -e SHORT=1 k6/stress.js
//   k6 run -e SHORT=1 -e MAX_RATE=1400 k6/stress.js   -> more steps, for a bigger server
import { login, resetBank, checkReconciliation, SHORT } from './lib/api.js';
import { bankingUser } from './lib/traffic.js';

const STEP = SHORT ? '20s' : '2m';
const MAX_RATE = Number(__ENV.MAX_RATE || 800);

// Steps of 100, 200, 400, then +200 up to MAX_RATE. Each step = a ramp then a plateau.
const LEVELS = [100, 200, 400];
for (let r = 600; r <= MAX_RATE; r += 200) LEVELS.push(r);

// Little's law: VUs needed = rate x response time. Budget 2 s per request at the top step
// (the 503 pool timeout), otherwise k6 runs out of VUs before the server breaks.
const MAX_VUS = Number(__ENV.MAX_VUS || Math.max(1500, MAX_RATE * 2));

export const options = {
  scenarios: {
    staircase: {
      executor: 'ramping-arrival-rate',
      startRate: 50,
      timeUnit: '1s',
      preAllocatedVUs: 100,
      maxVUs: MAX_VUS,
      stages: LEVELS.flatMap((target) => [{ target, duration: STEP }, { target, duration: STEP }]),
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
