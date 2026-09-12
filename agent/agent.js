const Groq = require('groq-sdk');
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const PROJECT_NAME = process.env.COMPOSE_PROJECT_NAME || path.basename(PROJECT_ROOT);
const MAX_REPLICAS = 5;
const MIN_REPLICAS = 1;
const LOOP_INTERVAL_MS = 60000;
const COMPOSE_COMMAND = process.env.COMPOSE_COMMAND || 'docker compose';
const DECISION_CSV = path.join(PROJECT_ROOT, 'results', 'agent_decisions.csv');
const CSV_HEADER = 'timestamp,action,replicas,confidence,reasoning,predicted_issue\n';
const VALID_ACTIONS = new Set(['scale_up', 'scale_down', 'alert', 'none']);

let currentReplicas = MIN_REPLICAS;

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
    console.warn(`[WARN] Could not detect running API replicas: ${err.message}`);
    return MIN_REPLICAS;
  }
}

function extractJsonObject(rawText) {
  if (typeof rawText !== 'string') {
    throw new Error('LLM response was not text');
  }
  const jsonStart = rawText.indexOf('{');
  const jsonEnd = rawText.lastIndexOf('}');
  if (jsonStart === -1 || jsonEnd <= jsonStart) {
    throw new Error('LLM response did not contain a JSON object');
  }
  return rawText.slice(jsonStart, jsonEnd + 1);
}

function validateDecision(decision) {
  if (!decision || typeof decision !== 'object' || Array.isArray(decision)) {
    throw new Error('Decision must be a JSON object');
  }
  if (!VALID_ACTIONS.has(decision.action)) {
    throw new Error(`Invalid action: ${String(decision.action)}`);
  }
  if (!Number.isFinite(Number(decision.confidence)) ||
      Number(decision.confidence) < 0.1 || Number(decision.confidence) > 1) {
    throw new Error('Confidence must be a number between 0.1 and 1.0');
  }
  if (decision.reasoning !== undefined && typeof decision.reasoning !== 'string') {
    throw new Error('Reasoning must be a string');
  }
  if (decision.predicted_issue !== undefined &&
      decision.predicted_issue !== null &&
      typeof decision.predicted_issue !== 'string') {
    throw new Error('Predicted issue must be a string or null');
  }
  if (decision.action === 'scale_up' || decision.action === 'scale_down') {
    if (!Number.isInteger(decision.replicas) ||
        decision.replicas < MIN_REPLICAS ||
        decision.replicas > MAX_REPLICAS) {
      throw new Error(`Replicas must be an integer between ${MIN_REPLICAS} and ${MAX_REPLICAS}`);
    }
  }

  return {
    action: decision.action,
    replicas: decision.replicas,
    confidence: Number(decision.confidence),
    reasoning: decision.reasoning || '',
    predicted_issue: decision.predicted_issue || null,
  };
}

function parseDecision(rawText) {
  let decision;
  try {
    decision = JSON.parse(extractJsonObject(rawText));
  } catch (err) {
    throw new Error(`Invalid LLM JSON: ${err.message}`);
  }
  return validateDecision(decision);
}

async function getMetricsWindow() {
  const end = Math.floor(Date.now() / 1000);
  const start = end - 300;
  const step = '15';

  async function query(metric) {
    const url = `http://localhost:9090/api/v1/query_range` +
      `?query=${encodeURIComponent(metric)}&start=${start}&end=${end}&step=${step}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
    if (!res.ok) throw new Error(`Prometheus HTTP status ${res.status}`);
    const data = await res.json();
    if (data.status !== 'success') throw new Error('Prometheus returned a non-success response');

    // Each query is already aggregated in PromQL and should return one series.
    const result = data.data?.result?.[0]?.values || [];
    return result
      .map(([timestamp, value]) => ({
        time: new Date(timestamp * 1000).toISOString().slice(11, 19),
        value: Number(value),
      }))
      .filter((point) => Number.isFinite(point.value));
  }

  const [avgLatency, errorRate, dbPool, cacheHitRate, requestRate, healthyTargets] = await Promise.all([
    query('(sum(rate(api_request_duration_seconds_sum[1m])) / sum(rate(api_request_duration_seconds_count[1m])) * 1000) or vector(0)'),
    query('(100 * sum(rate(api_errors_total[1m])) / sum(rate(api_requests_total[1m]))) or vector(0)'),
    query('max(api_db_connection_pool_used)'),
    query('(100 * sum(rate(api_cache_hits_total[1m])) / sum(rate(api_cache_requests_total[1m]))) or vector(0)'),
    query('sum(rate(api_requests_total[1m])) or vector(0)'),
    query('sum(up{job="api_replicas"})'),
  ]);

  return {
    avg_latency_ms: avgLatency,
    error_rate_percent: errorRate,
    db_pool_used: dbPool,
    cache_hit_rate_percent: cacheHitRate,
    request_rate: requestRate,
    healthy_targets: healthyTargets,
    current_replicas: currentReplicas,
  };
}

function hasUsableMetrics(metrics) {
  const healthy = metrics.healthy_targets.at(-1)?.value || 0;
  return healthy > 0 && metrics.request_rate.length > 0 &&
    metrics.avg_latency_ms.length > 0 && metrics.error_rate_percent.length > 0;
}

async function askAgent(metrics) {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) throw new Error('GROQ_API_KEY environment variable is not set');
  const groq = new Groq({ apiKey });

  const prompt = [
    'You are an autonomous infrastructure optimization agent for a containerized API system.',
    'Analyze the following aggregated telemetry data from the last 5 minutes (sampled every 15 seconds):',
    JSON.stringify(metrics, null, 2),
    '',
    'SCALING RULES (follow these strictly):',
    `- Current replicas running: ${metrics.current_replicas}`,
    '- If request_rate is 0 (or near 0) and current replicas > 1, scale_down to 1.',
    '- Scale up if recent latency is rising above 80ms or request_rate is growing rapidly.',
    '- Choose none only when traffic is active, the system is healthy, and replicas are optimal.',
    '',
    'Respond with only a JSON object. Do not use Markdown or code fences.',
    'The object must have these fields:',
    '{',
    '  "action": "scale_up" or "scale_down" or "alert" or "none",',
    '  "replicas": an integer from 1 to 5,',
    '  "confidence": a decimal from 0.1 to 1.0,',
    '  "reasoning": "one paragraph explaining the trend and decision",',
    '  "predicted_issue": "what will happen if no action is taken, or empty string"',
    '}',
  ].join('\n');

  const chatCompletion = await groq.chat.completions.create({
    messages: [
      {
        role: 'system',
        content: 'Return valid JSON only. Never add Markdown. Never choose a replica count outside 1 through 5.',
      },
      { role: 'user', content: prompt },
    ],
    model: 'openai/gpt-oss-20b',
    response_format: { type: 'json_object' },
    temperature: 0.2,
  });

  const rawText = chatCompletion.choices?.[0]?.message?.content;
  return parseDecision(rawText);
}

function csvEscape(value) {
  return `"${String(value ?? '').replace(/"/g, '""').replace(/\r?\n/g, ' ') }"`;
}

function appendDecisionLog(decision) {
  const resultsDir = path.dirname(DECISION_CSV);
  fs.mkdirSync(resultsDir, { recursive: true });
  if (!fs.existsSync(DECISION_CSV) || fs.statSync(DECISION_CSV).size === 0) {
    fs.writeFileSync(DECISION_CSV, CSV_HEADER);
  }

  const row = [
    new Date().toISOString(),
    decision.action,
    currentReplicas,
    decision.confidence,
    decision.reasoning,
    decision.predicted_issue,
  ].map(csvEscape).join(',');
  fs.appendFileSync(DECISION_CSV, `${row}\n`);
}

function scaleApi(targetReplicas) {
  execSync(
    `${COMPOSE_COMMAND} -p ${PROJECT_NAME} up --scale api=${targetReplicas} -d --no-recreate`,
    { stdio: 'inherit', cwd: PROJECT_ROOT },
  );
}

function executeDecision(decision) {
  if (decision.action === 'scale_up' || decision.action === 'scale_down') {
    const target = decision.replicas;
    if (target !== currentReplicas) {
      console.log(`[AGENT] ${decision.action.toUpperCase()}: ${currentReplicas} -> ${target}`);
      console.log(`[AGENT] Reasoning: ${decision.reasoning}`);
      try {
        scaleApi(target);
        currentReplicas = detectCurrentReplicas();
      } catch (err) {
        console.error(`[ERROR] Failed to execute scale command: ${err.message}`);
      }
    } else {
      console.log(`[AGENT] Already at ${currentReplicas} replicas; no change needed.`);
    }
  } else if (decision.action === 'alert') {
    console.log(`[AGENT] ALERT: ${decision.reasoning}`);
  } else {
    console.log('[AGENT] No scaling required.');
  }

  appendDecisionLog(decision);
}

async function run() {
  if (!process.env.GROQ_API_KEY) {
    console.error('Error: GROQ_API_KEY environment variable is not set.');
    process.exitCode = 1;
    return;
  }

  currentReplicas = detectCurrentReplicas();
  console.log('======================================================================');
  console.log('Agentic AI Infrastructure Optimizer started (using Groq + Llama 3.1)...');
  console.log(`Initial Replicas: ${currentReplicas} | Target Range: 1-5 | Loop Interval: 60s`);
  console.log('======================================================================');

  while (true) {
    try {
      console.log(`\n[${new Date().toLocaleTimeString()}] Fetching metrics window...`);
      const metrics = await getMetricsWindow();
      if (!hasUsableMetrics(metrics)) {
        throw new Error('Required aggregate metrics are missing or stale; no scaling action taken');
      }

      console.log(`[${new Date().toLocaleTimeString()}] Querying Groq for decision...`);
      const decision = await askAgent(metrics);
      console.log(`[${new Date().toLocaleTimeString()}] Decision: ${decision.action} (confidence ${decision.confidence})`);
      executeDecision(decision);
    } catch (err) {
      console.error(`[ERROR] Loop execution failed; no action taken: ${err.message}`);
    }
    await new Promise((resolve) => setTimeout(resolve, LOOP_INTERVAL_MS));
  }
}

if (require.main === module) run();

module.exports = {
  extractJsonObject,
  validateDecision,
  parseDecision,
  hasUsableMetrics,
  getMetricsWindow,
  executeDecision,
};
