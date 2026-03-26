/**
 * Pi Tau Mux Server
 * 
 * Standalone server that aggregates multiple pi instances.
 * - Serves web UI for browser clients
 * - Accepts connections from pi-tau-mux extensions
 * - Maintains session list by scanning ~/.pi/agent/sessions
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer, WebSocket } = require('ws');
const QRCode = require('qrcode');
const os = require('os');
const { execSync } = require('child_process');

// Configuration
const PORT = parseInt(process.env.TAU_PORT || '3001');
const HOME = process.env.HOME || os.homedir();
const SESSIONS_DIR = path.join(HOME, '.pi/agent/sessions');
const INSTANCES_DIR = path.join(HOME, '.pi/tau-instances');

// Static files - look relative to this file or in public dir
const STATIC_DIR = findPublicDir();

function findPublicDir() {
  const candidates = [
    path.join(__dirname, '..', 'public'),
    path.join(__dirname, '..', '..', 'pi-tau-mux', 'public'),
  ];
  
  for (const dir of candidates) {
    if (fs.existsSync(path.join(dir, 'index.html'))) {
      return dir;
    }
  }
  
  // Fallback
  return path.join(__dirname, '..', 'public');
}

// Session lifecycle thresholds
const ACTIVE_SESSION_THRESHOLD_MS = 15 * 60 * 1000; // 15 minutes (currently active)
const RECENT_SESSION_THRESHOLD_MS = 24 * 60 * 60 * 1000; // 24 hours (recently used)
const STALE_SESSION_THRESHOLD_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

// State
const browserClients = new Set();
const piClients = new Map(); // sessionId -> ws

// MIME types
const MIME_TYPES = {
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'application/javascript',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

// ─────────────────────────────────────────────────────────────
// Tailscale detection
// ─────────────────────────────────────────────────────────────

let tailscaleInfo = null;

function detectTailscale() {
  // First, try the CLI (most reliable if available)
  try {
    const status = execSync('tailscale status --json 2>/dev/null', { encoding: 'utf8', timeout: 2000 });
    const statusJson = JSON.parse(status);
    
    if (statusJson.BackendState === 'Running') {
      const self = statusJson.Self;
      if (self) {
        const tailscaleIp = self.TailscaleIPs?.[0] || null;
        const hostname = self.DNSName?.replace(/\.$/, '') || self.HostName || null;
        
        if (tailscaleIp || hostname) {
          return {
            ip: tailscaleIp,
            hostname: hostname,
            tailnet: statusJson.CurrentTailnet?.Name || null,
          };
        }
      }
    }
  } catch {}
  
  // Fallback: detect via network interfaces (100.x.x.x range is Tailscale)
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {
      if (net.family === 'IPv4' && net.address.startsWith('100.')) {
        return {
          ip: net.address,
          hostname: null, // Can't get without CLI
          tailnet: null,
        };
      }
    }
  }
  
  return null;
}

function getPreferredUrl(port) {
  // Prefer Tailscale hostname (works across devices on same tailnet)
  if (tailscaleInfo?.hostname) {
    return `http://${tailscaleInfo.hostname}:${port}`;
  }
  // Fall back to Tailscale IP
  if (tailscaleInfo?.ip) {
    return `http://${tailscaleInfo.ip}:${port}`;
  }
  // Fall back to local IP
  return `http://${getLocalIp()}:${port}`;
}

// ─────────────────────────────────────────────────────────────
// Session scanning and status detection
// ─────────────────────────────────────────────────────────────

function hasEndMarker(sessionFile) {
  try {
    const stats = fs.statSync(sessionFile);
    const readSize = Math.min(500, stats.size);
    const startPos = Math.max(0, stats.size - readSize);
    const buffer = Buffer.alloc(readSize);
    const fd = fs.openSync(sessionFile, 'r');
    fs.readSync(fd, buffer, 0, readSize, startPos);
    fs.closeSync(fd);
    return buffer.toString('utf8').includes('"type":"session_end"');
  } catch {
    return false;
  }
}

function getSessionStatus(sessionFile) {
  if (!fs.existsSync(sessionFile)) return 'ended';
  
  try {
    const stat = fs.statSync(sessionFile);
    const ageMs = Date.now() - stat.mtimeMs;
    
    if (hasEndMarker(sessionFile)) return 'ended';
    if (ageMs > STALE_SESSION_THRESHOLD_MS) return 'stale';
    if (ageMs < ACTIVE_SESSION_THRESHOLD_MS) return 'active';
    if (ageMs < RECENT_SESSION_THRESHOLD_MS) return 'recent';
    return 'ended';
  } catch {
    return 'ended';
  }
}

function decodeSessionDir(dirName) {
  let encoded = dirName.replace(/^--/, '').replace(/--$/, '');
  
  let paneId = null;
  const paneMatch = encoded.match(/^(.*)-(\d+)$/);
  if (paneMatch) {
    const withoutSuffix = paneMatch[1];
    const potentialCwd = '/' + withoutSuffix.replace(/-/g, '/');
    if (fs.existsSync(potentialCwd)) {
      encoded = withoutSuffix;
      paneId = parseInt(paneMatch[2]);
    }
  }
  
  const cwd = '/' + encoded.replace(/-/g, '/');
  return { cwd, paneId };
}

function getRecentlyModifiedSessionFiles() {
  const recentFiles = new Set();
  const now = Date.now();
  
  if (!fs.existsSync(SESSIONS_DIR)) return recentFiles;
  
  const dirEntries = fs.readdirSync(SESSIONS_DIR, { withFileTypes: true });
  for (const dir of dirEntries) {
    if (!dir.isDirectory()) continue;
    
    const projectDir = path.join(SESSIONS_DIR, dir.name);
    const files = fs.readdirSync(projectDir).filter(f => f.endsWith('.jsonl'));
    
    for (const file of files) {
      const filePath = path.join(projectDir, file);
      try {
        const stat = fs.statSync(filePath);
        if (now - stat.mtimeMs < ACTIVE_SESSION_THRESHOLD_MS) {
          recentFiles.add(filePath);
        }
      } catch {}
    }
  }
  
  return recentFiles;
}

async function parseSessionFile(filePath) {
  const readline = require('readline');
  const stream = fs.createReadStream(filePath, { encoding: 'utf8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  
  let header = null;
  let firstMessage = null;
  let sessionName = null;
  let userMessageCount = 0;
  let lineCount = 0;
  
  for await (const line of rl) {
    if (!line.trim()) continue;
    lineCount++;
    
    try {
      const entry = JSON.parse(line);
      if (entry.type === 'session') header = entry;
      else if (entry.type === 'session_info' && entry.name) sessionName = entry.name;
      else if (entry.type === 'message' && entry.message?.role === 'user') {
        userMessageCount++;
        if (!firstMessage) {
          const content = entry.message.content;
          if (typeof content === 'string') firstMessage = content.substring(0, 120);
          else if (Array.isArray(content)) {
            const tb = content.find(b => b.type === 'text');
            if (tb) firstMessage = tb.text.substring(0, 120);
          }
        }
      }
    } catch {}
    
    if (lineCount > 50 && firstMessage) break;
  }
  
  rl.close();
  stream.destroy();
  
  if (!header?.id) return null;
  if (userMessageCount <= 1 && lineCount <= 8) return null; // pipe mode
  
  return {
    id: header.id,
    timestamp: header.timestamp || '',
    name: sessionName,
    firstMessage,
    cwd: header.cwd || null,
  };
}

// ─────────────────────────────────────────────────────────────
// API endpoints
// ─────────────────────────────────────────────────────────────

async function serveSessionsList(res, statusFilter = null) {
  try {
    if (!fs.existsSync(SESSIONS_DIR)) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ projects: [] }));
      return;
    }
    
    const recentlyModifiedFiles = getRecentlyModifiedSessionFiles();
    const dirEntries = fs.readdirSync(SESSIONS_DIR, { withFileTypes: true });
    
    const allSessions = [];
    const sessionsByCwd = new Map();
    
    for (const dir of dirEntries) {
      if (!dir.isDirectory()) continue;
      
      const { cwd, paneId } = decodeSessionDir(dir.name);
      const projectDir = path.join(SESSIONS_DIR, dir.name);
      const files = fs.readdirSync(projectDir).filter(f => f.endsWith('.jsonl'));
      
      for (const file of files) {
        try {
          const filePath = path.join(projectDir, file);
          const parsed = await parseSessionFile(filePath);
          if (parsed) {
            const stat = fs.statSync(filePath);
            const status = getSessionStatus(filePath);
            const session = {
              ...parsed,
              file,
              filePath,
              mtime: stat.mtimeMs,
              isRecentlyModified: recentlyModifiedFiles.has(filePath),
              status,
              dirName: dir.name,
              decodedCwd: cwd,
              decodedPaneId: paneId
            };
            
            allSessions.push(session);
            
            if (!sessionsByCwd.has(cwd)) {
              sessionsByCwd.set(cwd, []);
            }
            sessionsByCwd.get(cwd).push(session);
          }
        } catch {}
      }
    }
    
    const projects = [];
    
    for (const dir of dirEntries) {
      if (!dir.isDirectory()) continue;
      
      const { cwd, paneId } = decodeSessionDir(dir.name);
      const sessions = allSessions.filter(s => {
        if (s.dirName !== dir.name) return false;
        if (statusFilter === 'active') return s.status === 'active';
        return s.status === 'active' || s.status === 'recent';
      });
      if (sessions.length === 0) continue;
      
      sessions.sort((a, b) => b.mtime - a.mtime);
      
      const baseName = path.basename(cwd);
      const allSessionsInThisDir = sessionsByCwd.get(cwd) || [];
      const hasMultiplePanes = allSessionsInThisDir.length > 1;
      
      const finalPaneId = paneId || (hasMultiplePanes ? allSessionsInThisDir.findIndex(s => s.dirName === dir.name) + 1 : null);
      const paneSuffix = finalPaneId ? `-${finalPaneId}` : '';
      
      const displayName = `${baseName}${paneSuffix}`;
      
      projects.push({
        path: dir.name,
        dirName: dir.name,
        sessions,
        displayName,
        cwd: cwd
      });
    }
    
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ projects }));
  } catch (e) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: e.message }));
  }
}

// ─────────────────────────────────────────────────────────────
// HTTP Server
// ─────────────────────────────────────────────────────────────

const server = http.createServer((req, res) => {
  let urlPath = req.url || '/';
  
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  
  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    res.end();
    return;
  }
  
  // API routes
  if (urlPath.startsWith('/api/')) {
    handleApiRoute(req, res, urlPath);
    return;
  }
  
  // Static files
  urlPath = urlPath.split('?')[0];
  if (urlPath === '/') urlPath = '/index.html';
  
  const filePath = path.join(STATIC_DIR, urlPath);
  
  if (!filePath.startsWith(STATIC_DIR)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }
  
  fs.stat(filePath, (err, stats) => {
    if (err || !stats.isFile()) {
      res.writeHead(404);
      res.end('Not Found');
      return;
    }
    
    const ext = path.extname(filePath).toLowerCase();
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';
    
    res.writeHead(200, { 'Content-Type': contentType });
    fs.createReadStream(filePath).pipe(res);
  });
});

function handleApiRoute(req, res, urlPath) {
  // Strip query string for route matching
  const cleanPath = urlPath.split('?')[0];
  
  if (cleanPath === '/api/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ 
      status: 'ok', 
      mode: 'mux', 
      browserClients: browserClients.size, 
      piClients: piClients.size,
      tailscale: tailscaleInfo
    }));
    return;
  }
  
  if (cleanPath === '/api/instances') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ instances: Array.from(piClients.keys()) }));
    return;
  }
  
  if (cleanPath === '/api/sessions' && req.method === 'GET') {
    // Parse query parameters (e.g., ?status=active)
    const url = new URL(req.url, `http://${req.headers.host}`);
    const statusFilter = url.searchParams.get('status');
    serveSessionsList(res, statusFilter);
    return;
  }
  
  if (cleanPath === '/api/qr') {
    const url = getPreferredUrl(PORT);
    QRCode.toDataURL(url, { width: 256, margin: 2 }).then(dataUrl => {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(`<!DOCTYPE html><html><head><meta name="viewport" content="width=device-width"></head><body style="display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:100vh;margin:0;background:#131316"><img src="${dataUrl}"><a href="${url}" style="color:#b87a5c">${url}</a></body></html>`);
    });
    return;
  }
  
  // Switch session (no-op in mux mode - just acknowledge)
  if (cleanPath === '/api/sessions/switch' && req.method === 'POST') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: true }));
    return;
  }
  
  // Load session file contents: /api/sessions/:dirName/:fileName
  const sessionMatch = urlPath.match(/^\/api\/sessions\/([^/]+)\/(.+)$/);
  if (sessionMatch && req.method === 'GET') {
    const dirName = sessionMatch[1];
    const fileName = sessionMatch[2];
    const sessionFile = path.join(SESSIONS_DIR, dirName, fileName);
    
    if (!fs.existsSync(sessionFile)) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Session file not found' }));
      return;
    }
    
    try {
      const entries = [];
      const content = fs.readFileSync(sessionFile, 'utf8');
      for (const line of content.split('\n')) {
        if (!line.trim()) continue;
        try {
          entries.push(JSON.parse(line));
        } catch {}
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ entries }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Failed to read session file' }));
    }
    return;
  }
  
  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Not found' }));
}

// ─────────────────────────────────────────────────────────────
// WebSocket Server - Browser clients
// ─────────────────────────────────────────────────────────────

const wss = new WebSocketServer({ noServer: true });

wss.on('connection', (ws) => {
  console.log('[Tau Mux] Browser client connected');
  browserClients.add(ws);
  ws.isAlive = true;
  
  ws.on('pong', () => { ws.isAlive = true; });
  
  ws.on('close', () => {
    console.log('[Tau Mux] Browser client disconnected');
    browserClients.delete(ws);
  });
  
  ws.on('error', (e) => {
    browserClients.delete(ws);
  });
});

// ─────────────────────────────────────────────────────────────
// WebSocket Server - Pi client connections
// ─────────────────────────────────────────────────────────────

const wssPi = new WebSocketServer({ noServer: true });

wssPi.on('connection', (ws) => {
  console.log('[Tau Mux] Pi client connected');
  
  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data.toString());
      handlePiMessage(ws, msg);
    } catch (e) {
      console.error('[Tau Mux] Failed to parse pi message:', e);
    }
  });
  
  ws.on('close', () => {
    console.log('[Tau Mux] Pi client disconnected');
    // Remove from piClients
    for (const [sessionId, client] of piClients.entries()) {
      if (client === ws) {
        piClients.delete(sessionId);
        break;
      }
    }
  });
});

server.on('upgrade', (request, socket, head) => {
  if (request.url === '/ws') {
    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit('connection', ws, request);
    });
  } else if (request.url === '/pi') {
    wssPi.handleUpgrade(request, socket, head, (ws) => {
      wssPi.emit('connection', ws, request);
    });
  } else {
    socket.destroy();
  }
});

function handlePiMessage(ws, msg) {
  switch (msg.type) {
    case 'register':
      piClients.set(msg.sessionId, ws);
      console.log(`[Tau Mux] Registered session: ${msg.sessionId}`);
      // Send server URLs back to the client
      ws.send(JSON.stringify({ 
        type: 'registered', 
        serverUrls: {
          local: `http://localhost:${PORT}`,
          tailscale: tailscaleInfo ? (tailscaleInfo.ip ? `http://${tailscaleInfo.ip}:${PORT}` : null) : null,
          magicDns: tailscaleInfo?.hostname ? `http://${tailscaleInfo.hostname}:${PORT}` : null
        }
      }));
      broadcastToBrowsers({ type: 'pi_registered', sessionId: msg.sessionId });
      break;
    
    case 'unregister':
      piClients.delete(msg.sessionId);
      console.log(`[Tau Mux] Unregistered session: ${msg.sessionId}`);
      broadcastToBrowsers({ type: 'pi_unregistered', sessionId: msg.sessionId });
      break;
    
    case 'event':
      // Forward events to browser clients
      broadcastToBrowsers({ type: 'event', event: msg.event });
      break;
    
    case 'state':
      // Update state for this session
      broadcastToBrowsers({ type: 'state_update', sessionId: msg.sessionId, state: msg.state });
      break;
  }
}

function broadcastToBrowsers(data) {
  const json = JSON.stringify(data);
  for (const client of browserClients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(json);
    }
  }
}

// ─────────────────────────────────────────────────────────────
// Heartbeat
// ─────────────────────────────────────────────────────────────

setInterval(() => {
  for (const client of browserClients) {
    if (client.readyState !== WebSocket.OPEN) {
      browserClients.delete(client);
      continue;
    }
    
    if (!client.isAlive) {
      client.terminate();
      browserClients.delete(client);
      continue;
    }
    
    client.isAlive = false;
    client.ping();
  }
}, 20000);

// ─────────────────────────────────────────────────────────────
// Utilities
// ─────────────────────────────────────────────────────────────

function getLocalIp() {
  const nets = os.networkInterfaces();
  const preferred = ['en0', 'en1'];
  
  for (const name of preferred) {
    for (const net of nets[name] || []) {
      if (net.family === 'IPv4' && !net.internal) {
        return net.address;
      }
    }
  }
  
  // Fallback
  for (const name of Object.keys(nets)) {
    for (const net of nets[name] || []) {
      if (net.family === 'IPv4' && !net.internal && (net.address.startsWith('192.168.') || net.address.startsWith('10.'))) {
        return net.address;
      }
    }
  }
  
  return 'localhost';
}

// ─────────────────────────────────────────────────────────────
// Start server
// ─────────────────────────────────────────────────────────────

// Detect Tailscale on startup
tailscaleInfo = detectTailscale();

server.listen(PORT, '0.0.0.0', () => {
  const localIp = getLocalIp();
  const localUrl = `http://${localIp}:${PORT}`;
  const preferredUrl = getPreferredUrl(PORT);
  
  if (tailscaleInfo) {
    console.log(`[Tau Mux] 🐺 Tailscale detected (${tailscaleInfo.tailnet || 'tailnet'})`);
    if (tailscaleInfo.hostname) {
      console.log(`[Tau Mux] MagicDNS: http://${tailscaleInfo.hostname}:${PORT}`);
    }
    if (tailscaleInfo.ip) {
      console.log(`[Tau Mux] Tailscale IP: http://${tailscaleInfo.ip}:${PORT}`);
    }
    console.log(`[Tau Mux] Local: ${localUrl}`);
  } else {
    console.log(`[Tau Mux] Server running on ${localUrl}`);
  }
  console.log(`[Tau Mux] WebSocket endpoints: /ws (browser), /pi (pi clients)`);
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`[Tau Mux] Port ${PORT} is in use. Set TAU_PORT env var to use a different port.`);
    process.exit(1);
  }
  throw err;
});