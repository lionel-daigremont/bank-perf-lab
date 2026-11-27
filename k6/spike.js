// SPIKE: "quincena" (payday). Salaries land on the 15th and at month end: within
// seconds everybody checks their balance and pays rent, bills, family transfers.
// Question answered: does the API absorb a sudden burst, and how fast does it recover?
// Two traffic streams + a probe:
//   - browsing: usual mix, x6 for one minute
//   - payroll payments: 0 -> 300 payments/s -> 0 (above the 200/s settlement capacity,
//     so the settlement queue fills up, then must drain back to 0)
//   - probe: reads /metrics every second (queue depth, DB pool, memory)
//   k6 run k6/spike.js            (~4 min)
//   k6 run -e SHORT=1 k6/spike.js (~2 min)
import { login, resetBank, checkReconciliation, SHORT } from './lib/api.js';
import { bankingUser, makePayment } from './lib/traffic.js';
import { monitorScenario, probe, DRIFT_THRESHOLDS } from './lib/monitor.js';

export { probe };

const sec = (s) => (SHORT ? Math.ceil(s / 2) : s);
const t = (s) => `${sec(s)}s`;
// The probe runs as long as the traffic, plus 30 s to watch the settlement queue
// drain back to 0 after the last request (the "tail" of the test).
const total = [30, 10, 60, 10, 120].reduce((sum, s) => sum + sec(s), 0) + 30;

export const options = {
  scenarios: {
    browsing: {
      executor: 'ramping-arrival-rate',
      startRate: 50, timeUnit: '1s', preAllocatedVUs: 50, maxVUs: 1000,
      stages: [
        { target: 50, duration: t(30) },   // normal day
        { target: 300, duration: t(10) },  // salaries land
        { target: 300, duration: t(60) },
        { target: 50, duration: t(10) },
        { target: 50, duration: t(120) },  // recovery window
      ],
      exec: 'browse',
    },
    payroll_payments: {
      executor: 'ramping-arrival-rate',
      startRate: 5, timeUnit: '1s', preAllocatedVUs: 50, maxVUs: 1000,
      stages: [
        { target: 5, duration: t(30) },
        { target: 300, duration: t(10) },
        { target: 300, duration: t(60) },
        { target: 5, duration: t(10) },
        { target: 5, duration: t(120) },
      ],
      exec: 'pay',
    },
    probe: monitorScenario(`${total}s`),
  },
  thresholds: {
    'http_req_duration{scenario:browsing}': ['p(95)<800'],
    'http_req_duration{scenario:payroll_payments}': ['p(95)<1000'],
    http_req_failed: ['rate<0.02'],
    settlement_drain_time: ['max<120000'], // the queue must be empty again within 2 min
    // No 'settlement_queue_depth: value==0' threshold here: it would only check the probe's
    // LAST one-second sample, taken while a payment may still be in flight, so it failed or
    // passed by chance (a flaky threshold). An empty queue is checked reliably instead by the
    // reconciliation in teardown(), which waits for the queue to drain, and by
    // settlement_drain_time above. Same trap as cutting a request mid-flight in JMeter.
    reconciliation_errors: ['count==0'],
    ...DRIFT_THRESHOLDS, // money conserved at every second of the run, not only at the end
  },
};

export function setup() {
  resetBank();
  return { token: login() };
}

export function browse({ token }) {
  bankingUser(token);
}

export function pay({ token }) {
  makePayment(token);
}

export function teardown() {
  checkReconciliation();
}
