// LOAD: the expected traffic of a normal busy hour, at a fixed arrival rate.
// Question answered: do we meet our SLOs at the expected load?
//   k6 run k6/load.js                 (100 req/s for 5 min)
//   k6 run -e SHORT=1 k6/load.js      (1 min)
//   k6 run -e RATE=200 k6/load.js     (another target)
import { login, resetBank, checkReconciliation, SHORT } from './lib/api.js';
import { bankingUser, ENDPOINT_THRESHOLDS } from './lib/traffic.js';
import { monitorScenario, probe, DRIFT_THRESHOLDS } from './lib/monitor.js';

export { probe };

const RATE = Number(__ENV.RATE || 100);
const DURATION = SHORT ? '1m' : '5m';

export const options = {
  scenarios: {
    busy_hour: {
      executor: 'constant-arrival-rate', // open model: users keep arriving even if the server slows down
      rate: RATE,
      timeUnit: '1s',
      duration: DURATION,
      preAllocatedVUs: 50,
      maxVUs: 300,
    },
    probe: monitorScenario(DURATION), // reads /metrics every second: money drift during the run
  },
  thresholds: {
    ...ENDPOINT_THRESHOLDS,
    ...DRIFT_THRESHOLDS,
    dropped_iterations: ['count==0'], // k6 could not keep up the planned rate (not enough VUs)
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
