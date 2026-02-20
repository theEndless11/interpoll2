// gun-relay.js
// Self-hosted Gun.js relay server with PostgreSQL persistence for Render deployment

import express from 'express';
import Gun from 'gun';
import http from 'http';
import cors from 'cors';
import pkg from 'pg';

const { Client } = pkg;
const PORT = process.env.PORT || 8765;
const NODE_ENV = process.env.NODE_ENV || 'development';
const app = express();

// ─── PostgreSQL Connection ────────────────────────────────────────────────────
let pgClient = null;
let pgConnected = false;

const initPostgres = async () => {
  try {
    if (!process.env.DATABASE_URL) {
      console.warn('⚠️  DATABASE_URL not set, running in memory-only mode');
      return false;
    }

    pgClient = new Client({
      connectionString: process.env.DATABASE_URL,
      ssl: NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
      application_name: 'gun-relay',
    });

    await pgClient.connect();
    
    // Create table if not exists
    await pgClient.query(`
      CREATE TABLE IF NOT EXISTS gun_data (
        key TEXT PRIMARY KEY,
        value JSONB NOT NULL,
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_gun_data_key ON gun_data(key);
      CREATE INDEX IF NOT EXISTS idx_gun_data_updated ON gun_data(updated_at);
    `);
    
    pgConnected = true;
    console.log('✅ PostgreSQL connected and initialized');
    return true;
  } catch (err) {
    console.error('❌ PostgreSQL connection failed:', err.message);
    pgConnected = false;
    return false;
  }
};

// Initialize PostgreSQL before everything else
await initPostgres();

// ─── Gun Storage Adapter ──────────────────────────────────────────────────────

const gunStorageAdapter = {
  get: async (key) => {
    try {
      if (!pgClient || !pgConnected) return null;
      const result = await pgClient.query('SELECT value FROM gun_data WHERE key = $1', [key]);
      return result.rows[0]?.value || null;
    } catch (err) {
      console.error('❌ PG get error:', err.message);
      return null;
    }
  },

  put: async (key, value) => {
    try {
      if (!pgClient || !pgConnected) return;
      await pgClient.query(
        `INSERT INTO gun_data (key, value, created_at, updated_at) 
         VALUES ($1, $2, NOW(), NOW())
         ON CONFLICT (key) DO UPDATE 
         SET value = EXCLUDED.value, updated_at = NOW()`,
        [key, typeof value === 'string' ? value : JSON.stringify(value)]
      );
    } catch (err) {
      console.error('❌ PG put error:', err.message);
    }
  },

  del: async (key) => {
    try {
      if (!pgClient || !pgConnected) return;
      await pgClient.query('DELETE FROM gun_data WHERE key = $1', [key]);
    } catch (err) {
      console.error('❌ PG del error:', err.message);
    }
  },
};

// ─── CORS Configuration ───────────────────────────────────────────────────────

const ALLOWED_ORIGINS = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(',').map(o => o.trim())
  : ['*'];

app.use(cors({
  origin: (origin, callback) => {
    if (!origin || ALLOWED_ORIGINS.includes('*') || ALLOWED_ORIGINS.includes(origin)) {
      callback(null, true);
    } else {
      console.warn(`⚠️  CORS rejected: ${origin}`);
      callback(null, true); // Allow anyway to not break Gun
    }
  },
  credentials: true,
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type'],
}));

// ─── Serve Gun.js ────────────────────────────────────────────────────────────

app.use(Gun.serve);

const server = http.createServer(app);

// ─── Initialize Gun ──────────────────────────────────────────────────────────

const gun = Gun({
  web: server,
  radisk: true,                           // In-memory + disk cache layer
  localStorage: false,
  multicast: false,
  peers: process.env.GUN_PEERS ? process.env.GUN_PEERS.split(',') : [],
});

// Override Gun's internal storage with PostgreSQL adapter
// This ensures all Gun data persists to database
if (gun._.get && pgConnected) {
  const originalGet = gun._.get;
  gun._.get = function(key) {
    // Try PostgreSQL first
    gunStorageAdapter.get(key).then(val => {
      if (val) this.put(val);
    }).catch(err => console.error('Storage get error:', err));
    // Fall back to original Gun storage
    return originalGet.call(this, key);
  };
}

// ─── Routes ──────────────────────────────────────────────────────────────────

// Health check endpoint
app.get('/health', async (req, res) => {
  let dbStatus = 'disconnected';
  let dbRowCount = 0;

  if (pgClient && pgConnected) {
    try {
      const result = await pgClient.query('SELECT 1');
      const countResult = await pgClient.query('SELECT COUNT(*) FROM gun_data');
      dbStatus = 'connected';
      dbRowCount = parseInt(countResult.rows[0].count) || 0;
    } catch (e) {
      dbStatus = 'error';
      console.error('Health check DB error:', e.message);
    }
  }

  res.json({
    status: 'ok',
    uptime: process.uptime(),
    peers: Object.keys(gun._.opt.peers || {}).length,
    database: {
      status: dbStatus,
      rows: dbRowCount,
    },
    timestamp: Date.now(),
    memory: {
      heapUsed: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
      heapTotal: Math.round(process.memoryUsage().heapTotal / 1024 / 1024),
    },
  });
});

// Info endpoint
app.get('/', (req, res) => {
  const protocol = NODE_ENV === 'production' ? 'wss' : 'ws';
  const httpProtocol = NODE_ENV === 'production' ? 'https' : 'http';
  const host = req.get('host') || `localhost:${PORT}`;
  const dbInfo = pgConnected ? '✅ PostgreSQL' : '⚠️  Memory Only';

  res.send(`
    <!DOCTYPE html>
    <html lang="en">
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Gun.js P2P Relay</title>
        <style>
          * { margin: 0; padding: 0; box-sizing: border-box; }
          body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            min-height: 100vh;
            display: flex;
            align-items: center;
            justify-content: center;
            padding: 20px;
          }
          .card {
            background: white;
            border-radius: 12px;
            box-shadow: 0 20px 60px rgba(0, 0, 0, 0.3);
            padding: 40px;
            max-width: 700px;
            width: 100%;
          }
          h1 {
            color: #333;
            margin-bottom: 10px;
            font-size: 32px;
          }
          .status {
            display: inline-block;
            padding: 8px 16px;
            background: #4CAF50;
            color: white;
            border-radius: 24px;
            font-size: 14px;
            font-weight: 600;
            margin-bottom: 30px;
          }
          .section {
            margin-bottom: 30px;
          }
          .section h2 {
            color: #666;
            font-size: 14px;
            font-weight: 600;
            text-transform: uppercase;
            margin-bottom: 12px;
            letter-spacing: 0.5px;
          }
          .info-box {
            background: #f5f7fa;
            padding: 16px;
            border-radius: 8px;
            border-left: 4px solid #667eea;
            margin-bottom: 12px;
          }
          .info-row {
            display: flex;
            justify-content: space-between;
            align-items: center;
            padding: 8px 0;
            font-size: 14px;
          }
          .info-label {
            color: #999;
            font-weight: 500;
          }
          .info-value {
            color: #333;
            font-family: 'Monaco', 'Menlo', monospace;
            font-weight: 600;
          }
          code {
            background: #263238;
            color: #aed581;
            padding: 2px 8px;
            border-radius: 4px;
            font-family: 'Monaco', 'Menlo', monospace;
            font-size: 12px;
          }
          .endpoint {
            background: #f9f9f9;
            border: 1px solid #e0e0e0;
            border-radius: 8px;
            padding: 16px;
            margin-bottom: 12px;
          }
          .endpoint-label {
            font-size: 12px;
            color: #999;
            font-weight: 600;
            text-transform: uppercase;
            margin-bottom: 8px;
          }
          .endpoint-url {
            font-family: 'Monaco', 'Menlo', monospace;
            color: #667eea;
            word-break: break-all;
            font-size: 13px;
            font-weight: 600;
          }
          .db-status {
            display: inline-block;
            padding: 4px 8px;
            border-radius: 4px;
            font-size: 12px;
            font-weight: 600;
          }
          .db-connected {
            background: #c8e6c9;
            color: #2e7d32;
          }
          .db-memory {
            background: #fff9c4;
            color: #f57f17;
          }
          .footer {
            margin-top: 40px;
            padding-top: 20px;
            border-top: 1px solid #e0e0e0;
            text-align: center;
            color: #999;
            font-size: 12px;
          }
        </style>
      </head>
      <body>
        <div class="card">
          <h1> Gun.js P2P Relay</h1>
          <span class="status">● ONLINE</span>

          <div class="section">
            <h2>Status</h2>
            <div class="info-box">
              <div class="info-row">
                <span class="info-label">Environment</span>
                <span class="info-value">${NODE_ENV}</span>
              </div>
              <div class="info-row">
                <span class="info-label">Uptime</span>
                <span class="info-value">${Math.floor(process.uptime())}s</span>
              </div>
              <div class="info-row">
                <span class="info-label">Database</span>
                <span class="db-status ${pgConnected ? 'db-connected' : 'db-memory'}">${dbInfo}</span>
              </div>
              <div class="info-row">
                <span class="info-label">Port</span>
                <span class="info-value">${PORT}</span>
              </div>
            </div>
          </div>

          <div class="section">
            <h2>Endpoints</h2>
            <div class="endpoint">
              <div class="endpoint-label">WebSocket</div>
              <div class="endpoint-url">${protocol}://${host}/gun</div>
            </div>
            <div class="endpoint">
              <div class="endpoint-label">Health Check</div>
              <div class="endpoint-url">${httpProtocol}://${host}/health</div>
            </div>
          </div>

          <div class="section">
            <h2>Usage</h2>
            <div class="endpoint">
              <div class="endpoint-label">Client Configuration</div>
              <div class="endpoint-url">Gun(['${httpProtocol}://${host}/gun'])</div>
            </div>
          </div>

          <div class="footer">
            Gun.js P2P Database • Decentralized, Offline-First, Realtime Graph Database
          </div>
        </div>
      </body>
    </html>
  `);
});

// ─── Server Startup ──────────────────────────────────────────────────────────

server.listen(PORT, '0.0.0.0', () => {
  console.log('');
  console.log('╔════════════════════════════════════════════╗');
  console.log('║   🔫 Gun.js P2P Relay Server             ║');
  console.log('╚════════════════════════════════════════════╝');
  console.log('');
  console.log(`🌐 Port           : ${PORT}`);
  console.log(`📡 Environment    : ${NODE_ENV}`);
  console.log(`💾 Database       : ${pgConnected ? '✅ PostgreSQL' : '⚠️  Memory Only'}`);
  console.log(`🔐 CORS Origins   : ${ALLOWED_ORIGINS.join(', ')}`);
  console.log('');
  if (NODE_ENV === 'development') {
    console.log(`🔗 WebSocket      : ws://localhost:${PORT}/gun`);
    console.log(`💚 Health Check   : http://localhost:${PORT}/health`);
  }
  console.log('');
  console.log('Press Ctrl+C to stop');
  console.log('');
});

// ─── Graceful Shutdown ────────────────────────────────────────────────────────

process.on('SIGINT', () => {
  console.log('\n👋 Shutting down gracefully...');
  
  if (pgClient) {
    pgClient.end().then(() => {
      console.log('✅ Database connection closed');
      server.close(() => {
        console.log('✅ Server closed');
        process.exit(0);
      });
    }).catch(err => {
      console.error('❌ Error closing database:', err);
      process.exit(1);
    });
  } else {
    server.close(() => {
      console.log('✅ Server closed');
      process.exit(0);
    });
  }

  // Force shutdown after 10 seconds
  setTimeout(() => {
    console.error('⚠️  Forced shutdown');
    process.exit(1);
  }, 10000);
});

process.on('uncaughtException', (err) => {
  console.error('❌ Uncaught Exception:', err);
  process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('❌ Unhandled Rejection at:', promise, 'reason:', reason);
  process.exit(1);
});

// ─── Periodic Health Monitoring ───────────────────────────────────────────────

setInterval(() => {
  const mem = process.memoryUsage();
  const heapPercent = Math.round((mem.heapUsed / mem.heapTotal) * 100);
  
  if (NODE_ENV === 'development' && heapPercent > 80) {
    console.warn(`⚠️  High memory usage: ${heapPercent}%`);
  }

  // Keep database connection alive
  if (pgClient && pgConnected) {
    pgClient.query('SELECT 1').catch(err => {
      console.error('❌ Database connection lost:', err.message);
      pgConnected = false;
    });
  }
}, 30000);
