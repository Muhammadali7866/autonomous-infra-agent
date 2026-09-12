const express = require('express');
const { Pool } = require('pg');
const redis = require('redis');

const app = express();
const port = Number(process.env.PORT || 3001);

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
pool.on('error', (err) => {
  console.error('[DB] Unexpected idle-client error:', err.message);
});

const cache = redis.createClient({ url: process.env.REDIS_URL });
cache.on('error', (err) => {
  console.error('[Redis] Client error:', err.message);
});

// Process-local counters are intentionally exported as Prometheus counters.
// Prometheus aggregates the per-replica series and calculates recent rates.
let requestCount = 0;
let errorCount = 0;
let cacheLookups = 0;
let cacheHits = 0;
let latencyCount = 0;
let latencySumSeconds = 0;
const latencyBucketsMs = [5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000];
const latencyBucketCounts = new Array(latencyBucketsMs.length).fill(0);
const startTime = Date.now();

function recordRequest(statusCode, durationMs) {
  requestCount += 1;
  if (statusCode >= 500) errorCount += 1;

  latencyCount += 1;
  latencySumSeconds += durationMs / 1000;
  latencyBucketsMs.forEach((bucket, index) => {
    if (durationMs <= bucket) latencyBucketCounts[index] += 1;
  });
}

function recordCacheLookup(hit) {
  cacheLookups += 1;
  if (hit) cacheHits += 1;
}

// Record all user-facing requests, including failed responses. Scrape and
// liveness endpoints are excluded so monitoring traffic does not affect the
// experiment's application metrics.
app.use((req, res, next) => {
  if (req.path === '/metrics' || req.path === '/health') return next();

  const started = process.hrtime.bigint();
  res.on('finish', () => {
    const durationMs = Number(process.hrtime.bigint() - started) / 1e6;
    recordRequest(res.statusCode, durationMs);
  });
  next();
});

// Install the body parser after the metrics middleware so malformed JSON and
// payload-limit responses are included in request duration/error metrics.
app.use(express.json({ limit: process.env.JSON_BODY_LIMIT || '100kb' }));

function prometheusMetrics() {
  const lines = [
    '# HELP api_uptime_seconds The total uptime of the API in seconds.',
    '# TYPE api_uptime_seconds gauge',
    `api_uptime_seconds ${(Date.now() - startTime) / 1000}`,
    '# HELP api_requests_total Total HTTP requests completed by this replica.',
    '# TYPE api_requests_total counter',
    `api_requests_total ${requestCount}`,
    '# HELP api_errors_total Total HTTP requests completed with a 5xx status.',
    '# TYPE api_errors_total counter',
    `api_errors_total ${errorCount}`,
    '# HELP api_request_duration_seconds HTTP request duration in seconds.',
    '# TYPE api_request_duration_seconds histogram',
  ];

  latencyBucketsMs.forEach((bucket, index) => {
    lines.push(
      `api_request_duration_seconds_bucket{le="${bucket / 1000}"} ${latencyBucketCounts[index]}`,
    );
  });
  lines.push(`api_request_duration_seconds_bucket{le="+Inf"} ${latencyCount}`);
  lines.push(`api_request_duration_seconds_sum ${latencySumSeconds}`);
  lines.push(`api_request_duration_seconds_count ${latencyCount}`);

  lines.push(
    '# HELP api_cache_requests_total Total cache lookups attempted by this replica.',
    '# TYPE api_cache_requests_total counter',
    `api_cache_requests_total ${cacheLookups}`,
    '# HELP api_cache_hits_total Total successful cache lookups by this replica.',
    '# TYPE api_cache_hits_total counter',
    `api_cache_hits_total ${cacheHits}`,
    '# HELP api_db_connection_pool_used Number of PostgreSQL connections currently in use.',
    '# TYPE api_db_connection_pool_used gauge',
    `api_db_connection_pool_used ${Math.max(0, pool.totalCount - pool.idleCount)}`,
  );

  return `${lines.join('\n')}\n`;
}

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    uptime_seconds: Math.floor((Date.now() - startTime) / 1000),
    db_pool_used: Math.max(0, pool.totalCount - pool.idleCount),
    redis_ready: cache.isReady,
  });
});

app.get('/metrics', (req, res) => {
  res.set('Content-Type', 'text/plain; version=0.0.4');
  res.send(prometheusMetrics());
});

app.post('/process', async (req, res) => {
  try {
    const result = await pool.query(
      'INSERT INTO events(data, created_at) VALUES($1, NOW()) RETURNING id',
      [JSON.stringify(req.body)],
    );
    const id = result.rows[0].id;
    let cached = false;

    // Redis is an optimization. A cache outage must not turn a committed
    // database write into a 500 response or cause clients to retry it.
    if (cache.isReady) {
      try {
        const serialized = JSON.stringify(req.body);
        await cache.set(`event:${id}`, serialized, { EX: 60 });
        await cache.sAdd('event:ids', String(id));
        cached = true;
      } catch (err) {
        console.warn('[Redis] Write skipped:', err.message);
      }
    }

    res.json({ success: true, id, cached });
  } catch (err) {
    console.error('[API] Process request failed:', err.message);
    res.status(500).json({ error: 'request processing failed' });
  }
});

app.get('/query', async (req, res) => {
  try {
    let cached = null;
    if (cache.isReady) {
      try {
        const eventId = await cache.sRandMember('event:ids');
        if (eventId) cached = await cache.get(`event:${eventId}`);
      } catch (err) {
        console.warn('[Redis] Read skipped:', err.message);
      }
    }

    recordCacheLookup(Boolean(cached));
    if (cached) {
      return res.json({ source: 'cache', data: JSON.parse(cached) });
    }

    // Retain the intentional database bottleneck for the experiment.
    const result = await pool.query('SELECT * FROM events ORDER BY RANDOM() LIMIT 1');
    res.json({ source: 'db', data: result.rows[0] || null });
  } catch (err) {
    console.error('[API] Query request failed:', err.message);
    res.status(500).json({ error: 'query failed' });
  }
});

async function start() {
  try {
    await pool.query(`CREATE TABLE IF NOT EXISTS events
      (id SERIAL PRIMARY KEY, data JSONB, created_at TIMESTAMP)`);

    if (!cache.isOpen) await cache.connect();

    app.listen(port, () => console.log(`API running on port ${port}`));
  } catch (err) {
    console.error('[STARTUP] API initialization failed:', err.message);
    await pool.end().catch(() => {});
    process.exitCode = 1;
  }
}

if (require.main === module) start();

module.exports = {
  app,
  prometheusMetrics,
  recordRequest,
  recordCacheLookup,
};
