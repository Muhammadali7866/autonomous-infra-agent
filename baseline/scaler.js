// WHAT IT DOES (every 30 seconds):
//   1. Asks Prometheus for the current average latency
//   2. If latency > 80ms  → scale UP   (add 1 more api replica, max 5)
//   3. If latency < 20ms  → scale DOWN (remove 1 api replica, min 1)
//   4. Otherwise          → do nothing
//   5. Logs every decision to console with a timestamp

const { execSync } = require("child_process");

// ─── Configuration ---------------------------------------------------
const PROMETHEUS_URL = "http://localhost:9090"; // Where Prometheus is running
const SCALE_UP_THRESHOLD = 80; // ms — scale up  if latency goes ABOVE this
const SCALE_DOWN_THRESHOLD = 20; // ms — scale down if latency goes BELOW this
const CHECK_INTERVAL = 30000; // 30 seconds between each check
const MAX_REPLICAS = 5; // Never scale above this
const MIN_REPLICAS = 1; // Never scale below this

// Track current replica count
let currentReplicas = 1;

// ─── fetch current latency from Prometheus
async function getLatency() {
  // Query Prometheus for the latest value of api_avg_latency_ms
  const url = `${PROMETHEUS_URL}/api/v1/query?query=api_avg_latency_ms`;

  const res = await fetch(url);
  const data = await res.json();

  const result = data?.data?.result?.[0]?.value?.[1];

  return parseFloat(result || 0);
}

// scale the api service using docker-compose
function scaleApi(targetReplicas) {
  execSync(`docker-compose up --scale api=${targetReplicas} -d --no-recreate`, {
    stdio: "inherit",
    cwd: process.cwd().includes("baseline")
      ? require("path").join(__dirname, "..") // run from project root
      : process.cwd(),
  });
}

//  LOGs
function log(message) {
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] ${message}`);
}

// ─── Main Loop runs every 30 seconds
async function checkAndScale() {
  try {
    // OBSERVE: get current latency from Prometheus
    const latency = await getLatency();

    log(`CHECK | latency=${latency}ms | replicas=${currentReplicas}`);

    // DECIDE: apply the rules
    if (latency > SCALE_UP_THRESHOLD && currentReplicas < MAX_REPLICAS) {
      currentReplicas++;
      log(
        `SCALE UP   → ${currentReplicas} replicas (latency=${latency}ms > ${SCALE_UP_THRESHOLD}ms threshold)`,
      );
      scaleApi(currentReplicas);
    } else if (
      latency < SCALE_DOWN_THRESHOLD &&
      currentReplicas > MIN_REPLICAS
    ) {
      // Latency is low — remove 1 api replica to save resources
      currentReplicas--;
      log(
        `SCALE DOWN → ${currentReplicas} replicas (latency=${latency}ms < ${SCALE_DOWN_THRESHOLD}ms threshold)`,
      );
      scaleApi(currentReplicas);
    } else {
      // Latency is within acceptable range — do nothing
      log(
        `NO ACTION  | latency is within ${SCALE_DOWN_THRESHOLD}ms–${SCALE_UP_THRESHOLD}ms range`,
      );
    }
  } catch (err) {
    // Log errors but keep running don't crash the scaler
    log(`ERROR | ${err.message}`);
  }
}

// ─── Start
log("Baseline rule-based scaler started");
log(
  `Rules: scale UP if latency > ${SCALE_UP_THRESHOLD}ms | scale DOWN if latency < ${SCALE_DOWN_THRESHOLD}ms`,
);
log(
  `Checking every ${CHECK_INTERVAL / 1000} seconds | replicas: min=${MIN_REPLICAS} max=${MAX_REPLICAS}`,
);
log("─".repeat(70));

// Run immediately on start, then repeat every 30 seconds
checkAndScale();
setInterval(checkAndScale, CHECK_INTERVAL);
