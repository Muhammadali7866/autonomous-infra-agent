const express = require('express');
const { Pool } = require('pg');
const redis = require('redis');

const app = express();
app.use(express.json());

// 1. Connection Configurations
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const cache = redis.createClient({ url: process.env.REDIS_URL });
cache.connect().catch(err => console.error('Redis Connection Error:', err));

// 2. Metrics Tracking 
let requestCount = 0;
let totalLatency = 0;
let errorCount = 0;
let cacheHits = 0;
const startTime = Date.now();


app.get('/health', (req, res) => {
    const poolStats = pool.totalCount > 0 ? pool : { totalCount: 0, idleCount: 0 };
    const uptime = Math.floor((Date.now() - startTime) / 1000);
    const avgLatency = requestCount > 0 ? Math.round(totalLatency / requestCount) : 0;
    const errorRate = requestCount > 0 ? +((errorCount / requestCount) * 100).toFixed(2) : 0;
    const dbUsed = poolStats.totalCount - poolStats.idleCount;
    const cacheHitRate = requestCount > 0 ? +(cacheHits / requestCount).toFixed(2) : 0;

    const metrics = `
# HELP api_uptime_seconds The total uptime of the API in seconds.
# TYPE api_uptime_seconds gauge
api_uptime_seconds ${uptime}

# HELP api_request_count The total number of requests processed.
# TYPE api_request_count counter
api_request_count ${requestCount}

# HELP api_avg_latency_ms The average latency in milliseconds.
# TYPE api_avg_latency_ms gauge
api_avg_latency_ms ${avgLatency}

# HELP api_error_rate_percent The error rate percentage.
# TYPE api_error_rate_percent gauge
api_error_rate_percent ${errorRate}

# HELP api_db_connection_pool_used The number of used DB connections.
# TYPE api_db_connection_pool_used gauge
api_db_connection_pool_used ${dbUsed}

# HELP api_cache_hit_rate The cache hit rate.
# TYPE api_cache_hit_rate gauge
api_cache_hit_rate ${cacheHitRate}
`.trim() + '\n';

    res.set('Content-Type', 'text/plain');
    res.send(metrics);
});

app.post('/process', async (req, res) => {
    const start = Date.now();
    requestCount++;
    try {
        await pool.query('INSERT INTO events(data, created_at) VALUES($1, NOW())',
            [JSON.stringify(req.body)]);
        await cache.set(`event:${requestCount}`, JSON.stringify(req.body), { EX: 60 });
        totalLatency += Date.now() - start;
        res.json({ success: true, id: requestCount });
    } catch (err) {
        errorCount++;
        res.status(500).json({ error: err.message });
    }
});

app.get('/query', async (req, res) => {
    const start = Date.now();
    requestCount++;
    try {
        const cached = await cache.get(`event:${Math.floor(Math.random() * requestCount) + 1}`);
        if (cached) {
            cacheHits++;
            totalLatency += Date.now() - start;
            return res.json({ source: 'cache', data: JSON.parse(cached) });
        }
        const result = await pool.query('SELECT * FROM events ORDER BY RANDOM() LIMIT 1');
        totalLatency += Date.now() - start;
        res.json({ source: 'db', data: result.rows[0] });
    } catch (err) {
        errorCount++;
        res.status(500).json({ error: err.message });
    }
});

pool.query(`CREATE TABLE IF NOT EXISTS events
  (id SERIAL PRIMARY KEY, data JSONB, created_at TIMESTAMP)`)
    .then(() => app.listen(3001, () => console.log('API running on port 3001')));
