
const { execSync } = require('child_process');
const path = require('path');

const PROMETHEUS_URL = process.env.PROMETHEUS_URL || 'http://localhost:9090';
const SCALE_UP_THRESHOLD = 80;
const SCALE_DOWN_THRESHOLD = 20;
const CHECK_INTERVAL = 30000;
const MAX_REPLICAS = 5;
const MIN_REPLICAS = 1;
const PROJECT_ROOT = path.resolve(__dirname, '..');
const PROJECT_NAME = process.env.COMPOSE_PROJECT_NAME || path.basename(PROJECT_ROOT);
const COMPOSE_COMMAND = process.env.COMPOSE_COMMAND || 'docker compose';

let currentReplicas = MIN_REPLICAS;
let checkRunning = false;

function detectCurrentReplicas() {
  try {
    const output = execSync(
      `docker ps --filter "label=com.docker.compose.project=${PROJECT_NAME}" ` +
      '--filter "label=com.docker.compose.service=api" --format "{{.ID}}"',
      { cwd: PROJECT_ROOT },
    ).toString();
    const count = output.trim() ? output.trim().split('\n').filter(Boolean).length : 0;
    return count > 0 ? count : MIN_REPLICAS;
  } catch (err) {
    log(`WARN | Could not detect running replicas: ${err.message}`);
    return currentReplicas;
  }
}

async function getLatency() {
  const healthyResponse = await fetch(
    `${PROMETHEUS_URL}/api/v1/query?query=${encodeURIComponent('sum(up{job="api_replicas"})')}`,
    { signal: AbortSignal.timeout(5000) },
  );
  if (!healthyResponse.ok) throw new Error(`Prometheus HTTP status ${healthyResponse.status}`);
  const healthyData = await healthyResponse.json();
  const healthyTargets = Number(healthyData.data?.result?.[0]?.value?.[1]);
  if (!Number.isFinite(healthyTargets) || healthyTargets < 1) return null;

  const query = encodeURIComponent(
    '(sum(rate(api_request_duration_seconds_sum[1m])) / ' +
    'sum(rate(api_request_duration_seconds_count[1m])) * 1000) or vector(0)',
  );
  const res = await fetch(
    `${PROMETHEUS_URL}/api/v1/query?query=${query}`,
    { signal: AbortSignal.timeout(5000) },
  );
  if (!res.ok) throw new Error(`Prometheus HTTP status ${res.status}`);

  const data = await res.json();
  if (data.status !== 'success') throw new Error('Prometheus returned a non-success response');
  const value = data.data?.result?.[0]?.value?.[1];
  const latency = Number(value);
  if (!Number.isFinite(latency)) return null;
  return latency;
}

function scaleApi(targetReplicas) {
  execSync(
    `${COMPOSE_COMMAND} -p ${PROJECT_NAME} up --scale api=${targetReplicas} -d --no-recreate`,
    {
      stdio: 'inherit',
      cwd: PROJECT_ROOT,
    },
  );
}

function log(message) {
  console.log(`[${new Date().toISOString()}] ${message}`);
}

async function checkAndScale() {
  if (checkRunning) {
    log('SKIP | previous check is still running');
    return;
  }
  checkRunning = true;

  try {
    currentReplicas = detectCurrentReplicas();
    const latency = await getLatency();
    if (latency === null) {
      log('NO ACTION | recent aggregate latency is unavailable');
      return;
    }

    log(`CHECK | aggregate_latency=${latency.toFixed(2)}ms | replicas=${currentReplicas}`);

    let target = currentReplicas;
    if (latency > SCALE_UP_THRESHOLD && currentReplicas < MAX_REPLICAS) {
      target += 1;
    } else if (latency < SCALE_DOWN_THRESHOLD && currentReplicas > MIN_REPLICAS) {
      target -= 1;
    }

    if (target === currentReplicas) {
      log(`NO ACTION | latency is within ${SCALE_DOWN_THRESHOLD}ms–${SCALE_UP_THRESHOLD}ms range`);
      return;
    }

    log(`SCALE | ${currentReplicas} -> ${target} replicas`);
    scaleApi(target);
    currentReplicas = detectCurrentReplicas();
    log(`SCALE COMPLETE | running replicas=${currentReplicas}`);
  } catch (err) {
    log(`ERROR | no scaling action taken: ${err.message}`);
  } finally {
    checkRunning = false;
  }
}

if (require.main === module) {
  log('Baseline rule-based scaler started');
  log(`Rules: scale UP > ${SCALE_UP_THRESHOLD}ms | scale DOWN < ${SCALE_DOWN_THRESHOLD}ms`);
  log(`Checking every ${CHECK_INTERVAL / 1000}s | replicas: min=${MIN_REPLICAS} max=${MAX_REPLICAS}`);
  checkAndScale();
  setInterval(checkAndScale, CHECK_INTERVAL);
}

module.exports = { getLatency, checkAndScale, detectCurrentReplicas };
