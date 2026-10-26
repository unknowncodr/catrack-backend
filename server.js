// Host agent: exposes the server list, lets clients start/stop servers
// and send console commands, and streams live console output.
//
//   GET  /status         -> plain health check, no auth
//   WS   /ws?token=...   -> authenticated. On connect sends the current
//                            server list. Accepts JSON messages:
//                              {type:"rescan"}
//                              {type:"start",   server:"<name>"}
//                              {type:"stop",    server:"<name>"}
//                              {type:"command", server:"<name>", text:"<cmd>"}
//                              {type:"get_logs", server:"<name>"}
//                            Broadcasts to all connected clients:
//                              {type:"console",      server, line}
//                              {type:"status_change", server, status}
//                              {type:"server_list",  servers}
require('dotenv').config({
  path: require('path').join(__dirname, '.env')
});

const http = require('http');
const path = require('path');
const { scanServers, SERVERS_DIR } = require('./scan');
const ProcessManager = require('./processManager');
const StatsPoller = require('./statsPoller');
const serverConfig = require('./serverConfig');
const { WebSocketServer } = require('ws');

const PORT = 8067;

// CHANGE THIS before exposing the tunnel to anyone but yourself.
// Later this should be a hashed secret loaded from a config/env file,
// not a plaintext string in the source.
const AUTH_TOKEN = process.env.AGENT_TOKEN;

if (!AUTH_TOKEN) {
  console.error(
    'ERROR: AGENT_TOKEN is missing. Check the .env file in the host-agent folder.'
  );
  process.exit(1);
}
// TPS (ticks per second) has no universal way to query it — vanilla
// and plain Fabric servers don't expose a command for it at all. It's
// only available if your server software/mods add a `tps` (or similar)
// console command:
//   - Paper / Spigot: built-in, `enabled: true, command: 'tps'` works.
//   - Forge:          built-in, use `command: 'forge tps'`.
//   - Fabric:         install the "Spark" mod, then `command: 'spark tps'`.
// Left disabled by default since these servers are vanilla/Fabric —
// the dashboard will just show TPS as unavailable until you enable it.
const TPS_POLLING = {
  enabled: false,
  command: 'tps',
  intervalMs: 10000,
};

const processManager = new ProcessManager(SERVERS_DIR);
const clients = new Set();

function broadcast(message) {
  const payload = JSON.stringify(message);
  for (const ws of clients) {
    if (ws.readyState === ws.OPEN) ws.send(payload);
  }
}

function currentServerList() {
  return scanServers(processManager.isRunning.bind(processManager));
}

// Guards set_ram/set_port/restart from acting on a name that isn't
// actually one of the scanned server folders (e.g. a stale client, or
// a name containing "../") before it touches the filesystem.
function isKnownServer(name) {
  return currentServerList().some((s) => s.name === name);
}

// Any console line or status change from any server goes out to every
// connected client — the frontend filters to whichever server view is
// currently open.
processManager.on('console', (msg) => broadcast({ type: 'console', ...msg }));
processManager.on('status_change', (msg) => {
  broadcast({ type: 'status_change', ...msg });
  broadcast({ type: 'server_list', servers: currentServerList() });
});

const statsPoller = new StatsPoller(processManager, currentServerList, TPS_POLLING);
statsPoller.on('stats', (msg) => broadcast({ type: 'stats', server: msg.server, data: msg.data }));

const httpServer = http.createServer((req, res) => {
  if (req.url === '/status') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'online', time: new Date().toISOString() }));
    return;
  }

  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not found');
});

const wss = new WebSocketServer({ noServer: true });

httpServer.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (url.pathname !== '/ws') {
    socket.destroy();
    return;
  }

  const token = url.searchParams.get('token');
  if (token !== AUTH_TOKEN) {
    console.log('Rejected WebSocket connection: bad or missing token');
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
    socket.destroy();
    return;
  }

  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit('connection', ws, req);
  });
});

wss.on('connection', (ws) => {
  console.log('Client connected');
  clients.add(ws);

  ws.send(JSON.stringify({ type: 'server_list', servers: currentServerList() }));

  ws.on('message', (data) => {
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      ws.send(JSON.stringify({ type: 'error', error: 'Invalid JSON' }));
      return;
    }

    console.log('Received:', msg);

    switch (msg.type) {
      case 'rescan':
        ws.send(JSON.stringify({ type: 'server_list', servers: currentServerList() }));
        break;

      case 'start': {
        const result = processManager.start(msg.server);
        if (!result.ok) ws.send(JSON.stringify({ type: 'error', error: result.error }));
        break;
      }

      case 'stop': {
        const result = processManager.stop(msg.server);
        if (!result.ok) ws.send(JSON.stringify({ type: 'error', error: result.error }));
        break;
      }

      case 'command': {
        const result = processManager.sendCommand(msg.server, msg.text);
        if (!result.ok) ws.send(JSON.stringify({ type: 'error', error: result.error }));
        break;
      }

      case 'get_logs':
        ws.send(JSON.stringify({
          type: 'log_history',
          server: msg.server,
          lines: processManager.getLogs(msg.server),
        }));
        break;

      case 'restart': {
        if (!isKnownServer(msg.server)) {
          ws.send(JSON.stringify({ type: 'error', error: 'Unknown server' }));
          break;
        }
        const result = processManager.restart(msg.server);
        if (!result.ok) ws.send(JSON.stringify({ type: 'error', error: result.error }));
        break;
      }

      case 'set_ram': {
        if (!isKnownServer(msg.server)) {
          ws.send(JSON.stringify({ type: 'error', error: 'Unknown server' }));
          break;
        }
        // null/blank clears the override and falls back to start.bat/
        // run.bat/plain java — see serverConfig.js and the comment on
        // buildLaunchCommand for what that tradeoff means.
        let ramMB = null;
        if (msg.ramMB !== null && msg.ramMB !== '' && msg.ramMB !== undefined) {
          ramMB = Number(msg.ramMB);
          if (!Number.isFinite(ramMB) || ramMB < 512 || ramMB > 65536) {
            ws.send(JSON.stringify({ type: 'error', error: 'RAM must be between 512 and 65536 MB' }));
            break;
          }
        }
        serverConfig.setRamMB(path.join(SERVERS_DIR, msg.server), ramMB);
        broadcast({ type: 'server_list', servers: currentServerList() });
        break;
      }

      case 'set_port': {
        if (!isKnownServer(msg.server)) {
          ws.send(JSON.stringify({ type: 'error', error: 'Unknown server' }));
          break;
        }
        const port = Number(msg.port);
        if (!Number.isInteger(port) || port < 1 || port > 65535) {
          ws.send(JSON.stringify({ type: 'error', error: 'Port must be between 1 and 65535' }));
          break;
        }
        serverConfig.setPort(path.join(SERVERS_DIR, msg.server), port);
        broadcast({ type: 'server_list', servers: currentServerList() });
        break;
      }

      default:
        ws.send(JSON.stringify({ type: 'error', error: `Unknown message type: ${msg.type}` }));
    }
  });

  ws.on('close', () => {
    console.log('Client disconnected');
    clients.delete(ws);
  });
});

httpServer.listen(PORT, () => {
  console.log(`Scanning for servers in: ${SERVERS_DIR}`);
  console.log(`Found: ${currentServerList().map(s => s.name).join(', ') || '(none)'}`);
  console.log(`Host agent listening on http://localhost:${PORT}`);
  console.log(`  HTTP status check: http://localhost:${PORT}/status`);
  console.log(`  WebSocket:         ws://localhost:${PORT}/ws?token=${AUTH_TOKEN}`);
  statsPoller.start();
});
