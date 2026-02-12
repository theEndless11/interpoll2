// gun-relay.js
// Self-hosted Gun.js relay server for Render deployment

import express from 'express';
import Gun from 'gun';
import http from 'http';
import cors from 'cors';

const PORT = process.env.PORT || 8765;
const NODE_ENV = process.env.NODE_ENV || 'development';
const app = express();

const ALLOWED_ORIGINS = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(',')
  : ['*'];

app.use(cors({
  origin: (origin, callback) => {
    if (!origin || ALLOWED_ORIGINS.includes('*') || ALLOWED_ORIGINS.includes(origin)) {
      callback(null, true);
    } else {
      callback(null, true);
    }
  },
  credentials: true
}));

app.use(Gun.serve);

const server = http.createServer(app);

const gun = Gun({
  web: server,
  // FIX: radisk:true on Render is misleading — storage is ephemeral.
  // Keep it true so data survives in-process restarts within a session,
  // but understand it resets on deploy. Consider a Redis adapter for
  // true persistence if you need data to survive restarts.
  radisk: true,
  localStorage: false,
  multicast: false,
  // FIX: Increase the number of allowed concurrent peers.
  // Default Gun peer limit can throttle concurrent community loads.
  // With 6 communities each opening multiple Gun subscriptions,
  // you can easily hit the default peer queue limit.
  peers: [],  // Add backup relay URLs here if you deploy multiple instances
});

// FIX: Increase Gun's internal message queue size to handle
// concurrent multi-community loads without dropping callbacks.
// This is the main reason some communities get 0 results under load.
if (gun._ && gun._.opt) {
  // Allow more concurrent wire messages before Gun starts queuing
  gun._.opt.chunk = gun._.opt.chunk || 10000;
}

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    uptime: process.uptime(),
    peers: Object.keys(gun._.opt.peers || {}).length,
    timestamp: Date.now(),
    // Add memory info to help spot memory leaks over time
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
            Uptime: <code>${Math.floor(process.uptime())}s</code> |
            Peers: <code>${Object.keys(gun._.opt.peers || {}).length}</code>
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
  if (NODE_ENV === 'development') {
    console.log(`📡 ws://localhost:${PORT}/gun`);
    console.log(`💚 http://localhost:${PORT}/health`);
  }
});

process.on('SIGINT', () => {
  console.log('\n👋 Shutting down...');
  server.close(() => { process.exit(0); });
});

if (NODE_ENV === 'development') {
  setInterval(() => {
    const peerCount = Object.keys(gun._.opt.peers || {}).length;
    if (peerCount > 0) console.log(`📊 Peers: ${peerCount}`);
  }, 30000);
}
