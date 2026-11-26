// A one-VU "probe" scenario that reads the server's /metrics every second and turns
// a few of them into k6 metrics. Same idea as watching the Transfer CFT catalogue:
// the queue must come back to 0 after each burst, and memory must not keep growing.
import http from 'k6/http';
import { sleep } from 'k6';
import { Gauge, Trend } from 'k6/metrics';
import { BASE_URL } from './api.js';

const queueDepth = new Gauge('settlement_queue_depth');
const poolWaiting = new Gauge('db_pool_waiting');
const memoryMb = new Gauge('server_memory_mb');
const drift = new Trend('money_drift_cents'); // a Trend, not a Gauge: thresholds on a Gauge only see the last value
const drainTime = new Trend('settlement_drain_time', true);

// Money created or destroyed, read every second (money in flight is counted by the server,
// so it must be exactly 0 at all times, not only at the end). Use in a script's thresholds.
export const DRIFT_THRESHOLDS = { money_drift_cents: ['min==0', 'max==0'] };

let drainStart = null;
let lastDrift = 0;
const started = Date.now();

function read(text, name) {
  const m = new RegExp(`^${name} (\\S+)$`, 'm').exec(text);
  return m ? Number(m[1]) : NaN;
}

export function monitorScenario(duration) {
  return { executor: 'constant-vus', vus: 1, duration, exec: 'probe' };
}

export function probe() {
  const res = http.get(`${BASE_URL}/metrics`, { tags: { name: 'GET /metrics' } });
  if (res.status === 200) {
    const depth = read(res.body, 'bank_settlement_queue_depth');
    queueDepth.add(depth);
    poolWaiting.add(read(res.body, 'bank_db_pool_waiting'));
    memoryMb.add(read(res.body, 'process_resident_memory_bytes') / 1024 / 1024);
    const d = read(res.body, 'bank_money_drift_cents');
    drift.add(d);
    if (d !== lastDrift) {
      // the reconciliation in teardown says IF money was lost; this line says WHEN
      console.warn(`t+${Math.round((Date.now() - started) / 1000)}s money drift: ${lastDrift} -> ${d} cents`);
      lastDrift = d;
    }
    if (depth > 100 && drainStart === null) drainStart = Date.now();
    if (depth === 0 && drainStart !== null) {
      drainTime.add(Date.now() - drainStart);
      drainStart = null;
    }
  }
  sleep(1);
}
