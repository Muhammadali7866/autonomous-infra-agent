const Groq = require('groq-sdk');
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const apiKey = process.env.GROQ_API_KEY;
if (!apiKey) {
  console.error("Error: GROQ_API_KEY environment variable is not set.");
  process.exit(1);
}

const groq = new Groq({ apiKey });
let currentReplicas = 1;
try {
  // Read actual running replicas from Docker
  const out = execSync('docker ps --filter "name=api" --format "{{.Names}}"').toString();
  const count = out.trim().split('\n').filter(n => n.includes('_api_')).length;
  if (count > 0) currentReplicas = count;
} catch (e) {
  // fallback
}
const decisionLog = [];

// OBSERVE — fetch last 5 minutes of metrics from Prometheus
async function getMetricsWindow() {
  const end = Math.floor(Date.now() / 1000);
  const start = end - 300; // 5 minute window
  const step = '15';       // 15-second intervals

  async function query(metric) {
    try {
      const url = `http://localhost:9090/api/v1/query_range` +
        `?query=${encodeURIComponent(metric)}&start=${start}&end=${end}&step=${step}`;
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP error! status: ${res.status}`);
      const data = await res.json();
      
      // Extract timestamps and values
      const result = data.data?.result?.[0]?.values || [];
      return result.map(v => ({
        time: new Date(v[0] * 1000).toISOString().substr(11, 8), 
        value: parseFloat(v[1])
      }));
    } catch (err) {
      console.warn(`[WARN] Failed to fetch metric "${metric}": ${err.message}`);
      return [];
    }
  }

  return {
    avg_latency_ms:     await query('api_avg_latency_ms'),
    error_rate_percent: await query('api_error_rate_percent'),
    db_pool_used:       await query('api_db_connection_pool_used'),
    cache_hit_rate:     await query('api_cache_hit_rate'),
    request_rate:       await query('rate(api_request_count[1m])'),
    current_replicas:   currentReplicas,
  };
}

// REASON — send metrics to Groq (Llama 3.1) for analysis
async function askAgent(metrics) {
  const prompt = [
    'You are an autonomous infrastructure optimization agent for a containerized API system.',
    'Analyze the following telemetry data from the last 5 minutes (sampled every 15 seconds):',
    JSON.stringify(metrics, null, 2),
    '',
    'SCALING RULES (follow these strictly):',
    `- Current replicas running: ${metrics.current_replicas}`,
    `- RULE 1: If request_rate is 0 (or near 0) and current replicas > 1, you MUST scale_down to save resources.`,
    '- RULE 2: SCALE UP if latency trend is rising above 80ms OR request_rate is growing rapidly.',
    '- RULE 3: NONE only if the system is healthy, traffic is active, and replicas are optimal.',
    '',
    'You MUST respond with ONLY a valid JSON object and nothing else. No explanation, no markdown, no code block.',
    'The JSON must have exactly these fields:',
    '{',
    '  "action": "scale_up" or "scale_down" or "alert" or "none",',
    '  "replicas": a number from 1 to 5 (target replica count),',
    '  "confidence": a decimal from 0.1 to 1.0,',
    '  "reasoning": "one paragraph explaining the trend and decision",',
    '  "predicted_issue": "what will happen if no action is taken, or empty string"',
    '}',
  ].join('\n');

  const chatCompletion = await groq.chat.completions.create({
    messages: [
      {
        role: 'system',
        content: 'You are an infrastructure optimization AI. Always respond with valid JSON only. Never add markdown. CRITICAL DIRECTIVE: If request_rate is 0 and current replicas > 1, you MUST output "action": "scale_down" and "replicas": 1 to save resources. Do not output "none" when traffic is zero.'
      },
      {
        role: 'user',
        content: prompt
      }
    ],
    model: 'llama-3.1-8b-instant',
    response_format: { type: 'json_object' },
    temperature: 0.2,
  });

  const rawText = chatCompletion.choices[0].message.content.trim();

  try {
    return JSON.parse(rawText);
  } catch (e) {
    throw new Error(`Failed to parse Groq response as JSON. Raw output was: ${rawText}`);
  }
}

// execute the agent's decision
function executeDecision(decision) {
  const { action, replicas, reasoning, predicted_issue, confidence } = decision;

  if (action === 'scale_up' || action === 'scale_down') {
    const target = Math.max(1, Math.min(5, replicas || currentReplicas));
    if (target !== currentReplicas) {
      console.log(`[AGENT] ${action.toUpperCase()}: Changing from ${currentReplicas} to ${target} replicas`);
      console.log(`[AGENT] Reasoning: ${reasoning}`);
      
      try {
        const projectRoot = process.cwd().includes('agent') 
          ? path.join(__dirname, '..') 
          : process.cwd();

        execSync(`docker-compose up --scale api=${target} -d --no-recreate`, {
          stdio: 'inherit',
          cwd: projectRoot
        });
        currentReplicas = target;
      } catch (err) {
        console.error(`[ERROR] Failed to execute scale command: ${err.message}`);
      }
    } else {
      console.log(`[AGENT] Decided to ${action}, but already at ${currentReplicas} replicas. No action taken.`);
    }

  } else if (action === 'alert') {
    console.log(`[AGENT] ALERT TRIGGERED: ${reasoning}`);
  } else {
    console.log(`[AGENT] No scaling required (latency trends stable).`);
  }

  decisionLog.push({
    timestamp: new Date().toISOString(),
    action, 
    replicas: currentReplicas,
    confidence, 
    reasoning, 
    predicted_issue: predicted_issue || null
  });

  const resultsDir = process.cwd().includes('agent')
    ? path.join(__dirname, '..', 'results')
    : path.join(process.cwd(), 'results');

  if (!fs.existsSync(resultsDir)) {
    fs.mkdirSync(resultsDir, { recursive: true });
  }

  const csvFile = path.join(resultsDir, 'agent_decisions.csv');
  const csvHeaders = 'timestamp,action,replicas,confidence,reasoning,predicted_issue\n';
  
  const csvRows = decisionLog.map(d => {
    const cleanReason = (d.reasoning || '').replace(/"/g, '""');
    const cleanIssue = (d.predicted_issue || '').replace(/"/g, '""');
    return `${d.timestamp},${d.action},${d.replicas},${d.confidence},"${cleanReason}","${cleanIssue}"`;
  });

  fs.writeFileSync(csvFile, csvHeaders + csvRows.join('\n'));
}

// Main loop — runs every 60 seconds
async function run() {
  console.log('======================================================================');
  console.log('Agentic AI Infrastructure Optimizer started (using Groq + Llama 3.1)...');
  console.log(`Initial Replicas: ${currentReplicas} | Target Range: 1-5 | Loop Interval: 60s`);
  console.log('======================================================================');

  while (true) {
    try {
      console.log(`\n[${new Date().toLocaleTimeString()}] Fetching metrics window...`);
      const metrics = await getMetricsWindow();
      
      console.log(`[${new Date().toLocaleTimeString()}] Querying Groq (Llama 3.1) for decision...`);
      const decision = await askAgent(metrics);
      
      console.log(`[${new Date().toLocaleTimeString()}] Decision received: ${decision.action.toUpperCase()} (Confidence: ${decision.confidence})`);
      executeDecision(decision);
    } catch (err) {
      console.error(`[ERROR] Loop execution failed: ${err.message}`);
    }
    await new Promise(resolve => setTimeout(resolve, 60000)); // wait 60s
  }
}

run();
