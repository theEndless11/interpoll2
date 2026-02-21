// gun-relay.js
// Gun.js relay server with MySQL persistence (Hostinger MySQL)

import express from 'express';
import Gun from 'gun';
import http from 'http';
import cors from 'cors';
import mysql from 'mysql2/promise';

const PORT = process.env.PORT || 8765;
const NODE_ENV = process.env.NODE_ENV || 'development';

const app = express();

// ─── MySQL ────────────────────────────────────────────────────────────────────
let db = null;
let dbConnected = false;

async function initMySQL() {
  try {
    if (!process.env.MYSQL_HOST) {
      console.warn('⚠️  MYSQL_HOST not set, running in memory-only mode');
      return false;
    }
    db = await mysql.createPool({
      host: process.env.MYSQL_HOST,
      user: process.env.MYSQL_USER,
      password: process.env.MYSQL_PASSWORD,
      database: process.env.MYSQL_DATABASE,
      port: process.env.MYSQL_PORT ? parseInt(process.env.MYSQL_PORT) : 3306,
      waitForConnections: true,
      connectionLimit: 10,
      ssl: { rejectUnauthorized: false },
    });
    await db.execute(`
      CREATE TABLE IF NOT EXISTS gun_nodes (
        soul VARCHAR(500) PRIMARY KEY,
        data LONGTEXT NOT NULL,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `);
    dbConnected = true;
    console.log('✅ MySQL connected');
    return true;
  } catch (err) {
    console.error('❌ MySQL connection failed:', err.message);
    dbConnected = false;
    return false;
  }
}

await initMySQL();

// ─── In-memory node accumulator ───────────────────────────────────────────────
// Gun sends data field-by-field: { "#": soul, ".": field, ":": value, ">": ts }
// We accumulate fields per soul and flush to MySQL periodically
const nodeBuffer = new Map(); // soul -> { field: value, ... }
const flushTimers = new Map(); // soul -> timer

async function flushNode(soul) {
  if (!dbConnected || !nodeBuffer.has(soul)) return;
  const data = nodeBuffer.get(soul);
  nodeBuffer.delete(soul);
  flushTimers.delete(soul);
  try {
    await db.execute(
      `INSERT INTO gun_nodes (soul, data) VALUES (?, ?)
       ON DUPLICATE KEY UPDATE 
         data = JSON_MERGE_PATCH(data, VALUES(data)),
         updated_at = NOW()`,
      [soul, JSON.stringify(data)]
    );
  } catch (err) {
    console.error('❌ MySQL flush error:', err.message);
  }
}

function bufferField(soul, field, value) {
  if (!nodeBuffer.has(soul)) nodeBuffer.set(soul, {});
  nodeBuffer.get(soul)[field] = value;

  // Debounce flush — wait 200ms after last field for this soul
  if (flushTimers.has(soul)) clearTimeout(flushTimers.get(soul));
  flushTimers.set(soul, setTimeout(() => flushNode(soul), 200));
}

// ─── Gun Storage Adapter ──────────────────────────────────────────────────────
function wireMySQL(gun) {
  if (!dbConnected) return;

  // Intercept Gun's wire-level put — each msg is one field of one node
  gun.on('put', function (msg) {
    this.to.next(msg);
    const put = msg?.put;
    if (!put) return;

    const soul = put['#'];
    const field = put['.'];
    const value = put[':'];

    if (!soul || field === undefined || value === undefined) return;

    // Skip Gun internal metadata souls
    if (soul.startsWith('~') || soul === 'undefined') return;

    bufferField(soul, field, value);
  });

  // Load full node from MySQL on Gun get request
  gun.on('get', async function (msg) {
    this.to.next(msg);
    const soul = msg?.get?.['#'];
    if (!soul) return;
    try {
      const [rows] = await db.execute('SELECT data FROM gun_nodes WHERE soul = ?', [soul]);
      if (rows.length === 0) return;
      const node = JSON.parse(rows[0].data);
      // Inject back into Gun graph
      const put = { [soul]: node };
      gun._.root.on('in', { '@': msg['#'], put });
    } catch (err) {
      console.error('❌ MySQL get error:', err.message);
    }
  });

  console.log('✅ MySQL Gun storage adapter wired');
}

// ─── CORS ─────────────────────────────────────────────────────────────────────
app.use(cors({ origin: (o, cb) => cb(null, true), credentials: true }));
app.use(Gun.serve);

const server = http.createServer(app);

// ─── Gun ──────────────────────────────────────────────────────────────────────
const gun = Gun({
  web: server,
  radisk: false,
  localStorage: false,
  multicast: false,
  peers: process.env.GUN_PEERS ? process.env.GUN_PEERS.split(',') : [],
});

wireMySQL(gun);

// ─── Health check ─────────────────────────────────────────────────────────────
app.get('/health', async (req, res) => {
  let dbRows = 0;
  if (db && dbConnected) {
    try {
      const [rows] = await db.execute('SELECT COUNT(*) as count FROM gun_nodes');
      dbRows = rows[0].count;
    } catch { /* ignore */ }
  }
  const mem = process.memoryUsage();
  res.json({
    status: 'ok',
    uptime: process.uptime(),
    peers: Object.keys(gun._.opt.peers || {}).length,
    database: { status: dbConnected ? 'connected' : 'disconnected', rows: dbRows },
    buffered: nodeBuffer.size,
    timestamp: Date.now(),
    memory: {
      heapUsed: Math.round(mem.heapUsed / 1024 / 1024),
      heapTotal: Math.round(mem.heapTotal / 1024 / 1024),
    },
  });
});

// ─── Info page ────────────────────────────────────────────────────────────────
app.get('/', (req, res) => {
  const proto = NODE_ENV === 'production' ? 'wss' : 'ws';
  const http_ = NODE_ENV === 'production' ? 'https' : 'http';
  const host = req.get('host') || `localhost:${PORT}`;
  res.send(`<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Gun Relay</title>
  <style>body{font-family:sans-serif;background:#667eea;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0}
  .card{background:#fff;border-radius:12px;padding:40px;max-width:500px;width:100%}
  h1{margin-bottom:8px}pre{background:#f5f5f5;padding:12px;border-radius:8px;font-size:13px}</style></head>
  <body><div class="card">
  <h1>🔫 Gun.js Relay</h1>
  <p>Status: <strong style="color:green">ONLINE</strong> | DB: <strong>${dbConnected ? '✅ MySQL' : '⚠️ Memory'}</strong></p>
  <pre>WebSocket: ${proto}://${host}/gun\nHTTP:      ${http_}://${host}/gun\nHealth:    ${http_}://${host}/health</pre>
  </div></body></html>`);
});

// ─── Start ────────────────────────────────────────────────────────────────────
server.listen(PORT, '0.0.0.0', () => {
  console.log(`🔫 Gun Relay on :${PORT} | DB: ${dbConnected ? '✅ MySQL' : '⚠️ Memory only'}`);
});

// ─── Graceful shutdown ────────────────────────────────────────────────────────
process.on('SIGINT', async () => {
  console.log('\n👋 Flushing buffers...');
  await Promise.all([...nodeBuffer.keys()].map(flushNode));
  if (db) await db.end();
  server.close(() => { console.log('✅ Done'); process.exit(0); });
  setTimeout(() => process.exit(1), 10000);
});

process.on('uncaughtException', (err) => { console.error('❌', err); process.exit(1); });
process.on('unhandledRejection', (r) => { console.error('❌', r); process.exit(1); });

// Keep MySQL alive
setInterval(async () => {
  if (db && dbConnected) {
    try { await db.execute('SELECT 1'); }
    catch (err) {
      console.error('❌ MySQL ping failed, reconnecting...', err.message);
      dbConnected = false;
      await initMySQL();
    }
  }
}, 30000);

