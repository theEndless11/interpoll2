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
const initPostgres = async () => {
  try {
    pgClient = new Client({
      connectionString: process.env.DATABASE_URL,
      ssl: NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
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
    `);
    
    console.log('✅ PostgreSQL connected');
    return true;
  } catch (err) {
    console.error('❌ PostgreSQL connection failed:', err.message);
    return false;
  }
};

// Custom Gun adapter for PostgreSQL
const pgAdapter = {
  get: async (key) => {
    try {
      if (!pgClient) return null;
      const result = await pgClient.query('SELECT value FROM gun_data WHERE key = $1', [key]);
      return result.rows[0]?.value || null;
    } catch (err) {
      console.error('PG get error:', err);
      return null;
    }
  },
  put: async (key, value) => {
    try {
      if (!pgClient) return;
      await pgClient.query(
        `INSERT INTO gun_data (key, value, updated_at) VALUES ($1, $2, NOW())
         ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = NOW()`,
        [key, value]
      );
    } catch (err) {
      console.error('PG put error:', err);
    }
  },
};

// Initialize before creating Gun
await initPostgres();

const ALLOWED_ORIGINS = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(',')
  : ['*'];

app.use(cors({
  origin: (origin, callback) => {
    callback(null, true);
  },
  credentials: true
}));

app.use(Gun.serve);

const server = http.createServer(app);

// ─── Gun with PostgreSQL backing ──────────────────────────────────────────────
const gun = Gun({
  web: server,
  radisk: true,  // Memory cache layer
  localStorage: false,
  multicast: false,
  peers: [],
});

// Override Gun's storage with PostgreSQL
if (gun._.get && pgClient) {
  gun._.storage = pgAdapter;
}

// Health check with DB status
app.get('/health', async (req, res) => {
  let dbStatus = 'disconnected';
  if (pgClient) {
    try {
      await pgClient.query('SELECT 1');
      dbStatus = 'connected';
    } catch (e) {
      dbStatus = 'error';
    }
  }

  res.json({
    status: 'ok',
    uptime: process.uptime(),
    peers: Object.keys(gun._.opt.peers || {}).length,
    database: dbStatus,
    timestamp: Date.now(),
    memory: process.memoryUsage(),
  });
});

app.get('/', (req, res) => {
  const protocol = NODE_ENV === 'production' ? 'wss' : 'ws';
  const httpProtocol = NODE_ENV === 'production' ? 'https' : 'http';
  const host = req.get('host') || `localhost:${PORT}`;

  res.send(`
    <html>
      <head>
        <title>Gun.js P2P Relay</title>
        <style>
          body { font-family: system-ui, -apple-system, sans-serif; max-width: 800px; margin: 50px auto; padding: 20px; background: #f5f5f5; }
          .card { background: white; padding: 30px; border-radius: 10px; box-shadow: 0 2px 10px rgba(0,0,0,0.1); }
          h1 { color: #333; margin: 0 0 20px; }
          .status { display: inline-block; padding: 5px 15px; background: #4CAF50; color: white; border-radius: 20px; font-size: 14px; margin-bottom: 20px; }
          .info { background: #e3f2fd; padding: 15px; border-radius: 5px; margin: 20px 0; }
          code { background: #263238; color: #aed581; padding: 2px 8px; border-radius: 3px; font-family: 'Courier New', monospace; }
          .endpoint { padding: 10px; background: #fafafa; margin: 10px 0; border-left: 3px solid #2196F3; }
        </style>
      </head>
      <body>
        <div class="card">
          <h1>🔫 Gun.js P2P Relay Server</h1>
          <span class="status">● ONLINE</span>
          <div class="info">
            Environment: <code>${NODE_ENV}</code> | Port: <code>${PORT}</code> |
            Database: <code>PostgreSQL</code> | Uptime: <code>${Math.floor(process.uptime())}s</code>
          </div>
          <div class="endpoint">
            <strong>WebSocket:</strong> <code>${protocol}://${host}/gun</code>
          </div>
          <div class="endpoint">
            <strong>Use in app:</strong> <code>Gun(['${httpProtocol}://${host}/gun'])</code>
          </div>
        </div>
      </body>
    </html>
  `);
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`🔫 Gun.js relay server running on port ${PORT} [${NODE_ENV}]`);
  console.log(`📊 Database: ${pgClient ? 'PostgreSQL' : 'Memory only'}`);
});

process.on('SIGINT', () => {
  console.log('\n👋 Shutting down...');
  if (pgClient) pgClient.end();
  server.close(() => { process.exit(0); });
});
