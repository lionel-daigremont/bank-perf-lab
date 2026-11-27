// SOAK (endurance): normal load for a long time, with a payday burst every hour,
// the same profile as the author's Transfer CFT endurance tests at Axway.
// Question answered: does the system degrade over time (memory leak, growing queue,
// slower responses, expired tokens...)?
//   k6 run k6/soak.js                  (4 h, burst every hour)
//   k6 run -e SHORT=1 k6/soak.js       (6 min, burst every 2 min)
//   start the API with --bug=leak to watch the memory curve climb
import { sleep } from 'k6';
import { login, resetBank, checkReconciliation, SHORT } from './lib/api.js';
import { bankingUser, makePayment } from './lib/traffic.js';
import { monitorScenario, probe, DRIFT_THRESHOLDS } from './lib/monitor.js';

export { probe };

const HOURS = Number(__ENV.HOURS || 4);
const cycleSec = SHORT ? 120 : 3600;
const cycles = SHORT ? 3 : HOURS;
const totalSec = cycleSec * cycles;

const scenarios = {
  background: {
    executor: 'constant-arrival-rate',
    rate: Number(__ENV.RATE || 80), timeUnit: '1s',
    duration: `${totalSec}s`,
    preAllocatedVUs: 50, maxVUs: 300,
    exec: 'browse',
  },
  probe: monitorScenario(`${totalSec + 30}s`),
};
// One burst of 3,000 payments in the middle of every cycle.
for (let i = 0; i < cycles; i++) {
  scenarios[`burst_${i + 1}`] = {
    executor: 'shared-iterations',
    vus: 100, iterations: 3000, maxDuration: '2m',
    startTime: `${i * cycleSec + cycleSec / 2}s`,
    exec: 'pay',
  };
}

export const options = {
  scenarios,
  thresholds: {
    'http_req_duration{scenario:background}': ['p(95)<500'],
    http_req_failed: ['rate<0.01'],
    settlement_drain_time: ['max<120000'],
    // No 'settlement_queue_depth: value==0' threshold here: it would only check the probe's
    // LAST one-second sample, taken while a payment may still be in flight, so it failed or
    // passed by chance (a flaky threshold). An empty queue is checked reliably instead by the
    // reconciliation in teardown(), which waits for the queue to drain, and by
    // settlement_drain_time above. Same trap as cutting a request mid-flight in JMeter.
    server_memory_mb: [`value<${SHORT ? 256 : 512}`], // a leak makes memory climb burst after burst
    reconciliation_errors: ['count==0'],
    ...DRIFT_THRESHOLDS, // money conserved at every second of the run, not only at the end
  },
};

export function setup() {
  resetBank();
  return { token: login() };
}

// The token expires after TOKEN_TTL_S (1 h by default): in a real soak test each VU
// would renew it. Here setup() gets one token; run the API with TOKEN_TTL_S=86400
// for runs longer than an hour, or see the README exercise "token refresh".
export function browse({ token }) {
  bankingUser(token);
}

export function pay({ token }) {
  makePayment(token);
  sleep(0.1);
}

export function teardown() {
  checkReconciliation();
}
