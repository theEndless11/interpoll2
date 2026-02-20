
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

// ─── MySQL Connection ─────────────────────────────────────────────────────────
// Set these env vars on Render:
// MYSQL_HOST     = your Hostinger MySQL host (e.g. srv1234.hstgr.io)
// MYSQL_USER     = your MySQL username
// MYSQL_PASSWORD = your MySQL password
// MYSQL_DATABASE = your database name
// MYSQL_PORT     = 3306 (default)

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
      CREATE TABLE IF NOT EXISTS gun_data (
        gun_key VARCHAR(500) PRIMARY KEY,
        gun_value LONGTEXT NOT NULL,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        INDEX idx_updated (updated_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `);

    dbConnected = true;
    console.log('✅ MySQL connected and initialized');
    return true;
  } catch (err) {
    console.error('❌ MySQL connection failed:', err.message);
    dbConnected = false;
    return false;
  }
}

await initMySQL();

// ─── Gun Storage Adapter ──────────────────────────────────────────────────────
function wireMySQL(gun) {
  if (!dbConnected) return;

  gun.on('put', async function (msg) {
    this.to.next(msg);
    if (!msg?.put) return;
    try {
      const batch = [];
      for (const [soul, node] of Object.entries(msg.put)) {
        if (!node || typeof node !== 'object') continue;
        batch.push([soul, JSON.stringify(node)]);
      }
      if (batch.length === 0) return;
      const placeholders = batch.map(() => '(?, ?)').join(', ');
      await db.execute(
        `INSERT INTO gun_data (gun_key, gun_value) VALUES ${placeholders}
         ON DUPLICATE KEY UPDATE gun_value = VALUES(gun_value), updated_at = NOW()`,
        batch.flat()
      );
    } catch (err) { console.error('❌ MySQL put error:', err.message); }
  });

  gun.on('get', async function (msg) {
    this.to.next(msg);
    const soul = msg?.get?.['#'];
    if (!soul) return;
    try {
      const [rows] = await db.execute('SELECT gun_value FROM gun_data WHERE gun_key = ?', [soul]);
      if (rows.length === 0) return;
      const node = JSON.parse(rows[0].gun_value);
      gun._.root.gun._.on('in', { '@': msg['#'], put: { [soul]: node } });
    } catch (err) { console.error('❌ MySQL get error:', err.message); }
  });

  console.log('✅ MySQL Gun storage adapter wired');
}

// ─── CORS ─────────────────────────────────────────────────────────────────────
const ALLOWED_ORIGINS = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(',').map(o => o.trim())
  : ['*'];

app.use(cors({
  origin: (origin, callback) => callback(null, true),
  credentials: true,
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type'],
}));

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
      const [rows] = await db.execute('SELECT COUNT(*) as count FROM gun_data');
      dbRows = rows[0].count;
    } catch { /* ignore */ }
  }
  const mem = process.memoryUsage();
  res.json({
    status: 'ok',
    uptime: process.uptime(),
    peers: Object.keys(gun._.opt.peers || {}).length,
    database: { status: dbConnected ? 'connected' : 'disconnected', rows: dbRows },
    timestamp: Date.now(),
    memory: {
      heapUsed: Math.round(mem.heapUsed / 1024 / 1024),
      heapTotal: Math.round(mem.heapTotal / 1024 / 1024),
    },
  });
});

// ─── Info page ────────────────────────────────────────────────────────────────
app.get('/', (req, res) => {
  const protocol = NODE_ENV === 'production' ? 'wss' : 'ws';
  const httpProtocol = NODE_ENV === 'production' ? 'https' : 'http';
  const host = req.get('host') || `localhost:${PORT}`;
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Gun.js P2P Relay</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: -apple-system, sans-serif; background: linear-gradient(135deg, #667eea, #764ba2); min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 20px; }
    .card { background: white; border-radius: 12px; box-shadow: 0 20px 60px rgba(0,0,0,0.3); padding: 40px; max-width: 600px; width: 100%; }
    h1 { color: #333; margin-bottom: 10px; font-size: 28px; }
    .status { display: inline-block; padding: 6px 14px; background: #4CAF50; color: white; border-radius: 24px; font-size: 13px; font-weight: 600; margin-bottom: 24px; }
    .info-box { background: #f5f7fa; padding: 16px; border-radius: 8px; border-left: 4px solid #667eea; margin-bottom: 16px; }
    .row { display: flex; justify-content: space-between; padding: 6px 0; font-size: 14px; }
    .label { color: #999; } .value { color: #333; font-family: monospace; font-weight: 600; }
    .endpoint { background: #f9f9f9; border: 1px solid #e0e0e0; border-radius: 8px; padding: 14px; margin-bottom: 10px; font-family: monospace; color: #667eea; font-size: 13px; }
    .endpoint-label { font-size: 11px; color: #999; font-weight: 600; text-transform: uppercase; margin-bottom: 6px; }
  </style>
</head>
<body>
  <div class="card">
    <h1>🔫 Gun.js P2P Relay</h1>
    <span class="status">● ONLINE</span>
    <div class="info-box">
      <div class="row"><span class="label">Environment</span><span class="value">${NODE_ENV}</span></div>
      <div class="row"><span class="label">Uptime</span><span class="value">${Math.floor(process.uptime())}s</span></div>
      <div class="row"><span class="label">Database</span><span class="value">${dbConnected ? '✅ MySQL (Hostinger)' : '⚠️ Memory Only'}</span></div>
      <div class="row"><span class="label">Port</span><span class="value">${PORT}</span></div>
    </div>
    <div class="endpoint-label">WebSocket</div>
    <div class="endpoint">${protocol}://${host}/gun</div>
    <div class="endpoint-label">Client Usage</div>
    <div class="endpoint">Gun(['${httpProtocol}://${host}/gun'])</div>
  </div>
</body>
</html>`);
});

// ─── Start ────────────────────────────────────────────────────────────────────
server.listen(PORT, '0.0.0.0', () => {
  console.log('');
  console.log('╔════════════════════════════════════════════╗');
  console.log('║   🔫 Gun.js P2P Relay Server              ║');
  console.log('╚════════════════════════════════════════════╝');
  console.log('');
  console.log(`🌐 Port     : ${PORT}`);
  console.log(`📡 Env      : ${NODE_ENV}`);
  console.log(`💾 Database : ${dbConnected ? '✅ MySQL (Hostinger)' : '⚠️  Memory Only'}`);
  console.log('');
});

process.on('SIGINT', async () => {
  console.log('\n👋 Shutting down...');
  if (db) await db.end();
  server.close(() => { console.log('✅ Server closed'); process.exit(0); });
  setTimeout(() => process.exit(1), 10000);
});

process.on('uncaughtException', (err) => { console.error('❌ Uncaught Exception:', err); process.exit(1); });
process.on('unhandledRejection', (reason) => { console.error('❌ Unhandled Rejection:', reason); process.exit(1); });

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
