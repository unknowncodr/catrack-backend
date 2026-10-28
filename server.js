// Host agent: exposes the server list, lets clients start/stop servers
// and send console commands, and streams live console output.
//
//   GET  /status         -> plain health check, no auth
//   WS   /ws?token=...   -> authenticated. On connect sends {type:"permissions"}
//                            then the server list (filtered to what the token
//                            may see). Accepts JSON messages:
//                              {type:"rescan"}
//                              {type:"start",   server:"<name>"}   (admin)
//                              {type:"stop",    server:"<name>"}   (admin)
//                              {type:"restart", server:"<name>"}   (admin)
//                              {type:"command", server:"<name>", text:"<cmd>"}  (console)
//                              {type:"get_logs", server:"<name>"}  (console)
//                              {type:"set_ram",  server:"<name>", ramMB:<n|null>}  (admin)
//                              {type:"set_port", server:"<name>", port:<n>}        (admin)
//                              {type:"get_players"/"get_player", ...}
//                              {type:"watch",   server:"<name>"}
//                              {type:"unwatch"}
//                            Pushed to each client, only for servers its token
//                            may see ("console" also needs the console perm):
//                              {type:"console",      server, line}
//                              {type:"status_change", server, status}
//                              {type:"server_list",  servers}
//                              {type:"stats",        server, data}
//                              {type:"permissions",  label, servers, console, admin}
//                            Sent to the watching client:
//                              {type:"history", server, now, samples}
//
// Tokens and their permissions are configured in .env, see auth.js.
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
const players = require('./players');
const auth = require('./auth');

const PORT = 8067;

const { tokens: TOKENS, warnings: TOKEN_WARNINGS } = auth.loadTokens(process.env);
TOKEN_WARNINGS.forEach((w) => console.warn(`WARNING: ${w}`));

if (TOKENS.length === 0) {
  console.error(
    'ERROR: No valid tokens found. Set AGENT_TOKEN (and optionally AGENT_TOKEN_<name>) in the .env file in the host-agent folder.'
  );
  process.exit(1);
}

// TPS / MSPT comes from vanilla's `/tick query` command (Minecraft
// 1.20.3+, works on vanilla and Fabric with no mods). It's only polled
// for servers a client currently has open in the detail view, so the
// command doesn't run 24/7 on every server. Servers older than 1.20.3
// reply "Unknown command" once and are then left alone until restarted.
// The reply is hidden from the dashboard console, but the server still
// writes it to its own latest.log.
const TPS_POLLING = {
  enabled: true,
  command: 'tick query',
  intervalMs: 5000,
};

const processManager = new ProcessManager(SERVERS_DIR);
const clients = new Set();

function send(ws, message) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(message));
}

// Sends to every client whose token passes `allow(auth)`.
function broadcast(message, allow = () => true) {
  const payload = JSON.stringify(message);
  for (const ws of clients) {
    if (ws.readyState === ws.OPEN && allow(ws.auth)) ws.send(payload);
  }
}

function currentServerList() {
  return scanServers(processManager.isRunning.bind(processManager));
}

// The server list as one particular token is allowed to see it.
function serverListFor(a) {
  return currentServerList().filter((s) => auth.canSee(a, s.name));
}

function sendServerList(ws) {
  send(ws, { type: 'server_list', servers: serverListFor(ws.auth) });
}

function broadcastServerList() {
  for (const ws of clients) sendServerList(ws);
}

// Guards every server-specific action: the name must be a real scanned
// server folder (blocks "../" etc.) AND the token must be allowed to see
// it. Restricted tokens get the same "Unknown server" answer for a
// server that exists but is hidden from them, so names don't leak.
// `need` is 'console' or 'admin' for actions beyond plain viewing.
function authorize(ws, serverName, need = null) {
  if (!currentServerList().some((s) => s.name === serverName) || !auth.canSee(ws.auth, serverName)) {
    send(ws, { type: 'error', error: 'Unknown server' });
    return false;
  }
  if (need && !ws.auth[need]) {
    send(ws, { type: 'error', error: `Your token does not have ${need} permission` });
    return false;
  }
  return true;
}

// Console lines need the console permission as well as access to the
// server (they contain chat, IPs, commands...).
processManager.on('console', (msg) => broadcast(
  { type: 'console', ...msg },
  (a) => a.console && auth.canSee(a, msg.server),
));
processManager.on('status_change', (msg) => {
  broadcast({ type: 'status_change', ...msg }, (a) => auth.canSee(a, msg.server));
  broadcastServerList();
});

const statsPoller = new StatsPoller(processManager, currentServerList, TPS_POLLING);
statsPoller.on('stats', (msg) => broadcast(
  { type: 'stats', server: msg.server, data: msg.data },
  (a) => auth.canSee(a, msg.server),
));

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

  const tokenEntry = auth.authenticate(TOKENS, url.searchParams.get('token'));
  if (!tokenEntry) {
    console.log('Rejected WebSocket connection: bad or missing token');
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
    socket.destroy();
    return;
  }

  wss.handleUpgrade(req, socket, head, (ws) => {
    ws.auth = tokenEntry;
    wss.emit('connection', ws, req);
  });
});

wss.on('connection', (ws) => {
  console.log(`Client connected (token: ${ws.auth.label})`);
  clients.add(ws);
  ws.watching = null; // server name this client has open in the detail view

  function stopWatching() {
    if (ws.watching) {
      statsPoller.unwatch(ws.watching);
      ws.watching = null;
    }
  }

  send(ws, { type: 'permissions', ...auth.describe(ws.auth) });
  sendServerList(ws);

  ws.on('message', (data) => {
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      send(ws, { type: 'error', error: 'Invalid JSON' });
      return;
    }

    console.log(`Received (${ws.auth.label}):`, msg);

    switch (msg.type) {
      case 'rescan':
        sendServerList(ws);
        break;

      case 'start': {
        if (!authorize(ws, msg.server, 'admin')) break;
        const result = processManager.start(msg.server);
        if (!result.ok) send(ws, { type: 'error', error: result.error });
        break;
      }

      case 'stop': {
        if (!authorize(ws, msg.server, 'admin')) break;
        const result = processManager.stop(msg.server);
        if (!result.ok) send(ws, { type: 'error', error: result.error });
        break;
      }

      case 'command': {
        if (!authorize(ws, msg.server, 'console')) break;
        const result = processManager.sendCommand(msg.server, msg.text);
        if (!result.ok) send(ws, { type: 'error', error: result.error });
        break;
      }

      case 'get_logs':
        if (!authorize(ws, msg.server, 'console')) break;
        send(ws, {
          type: 'log_history',
          server: msg.server,
          lines: processManager.getLogs(msg.server),
        });
        break;

      case 'watch': {
        if (!authorize(ws, msg.server)) break;
        if (ws.watching !== msg.server) {
          stopWatching();
          statsPoller.watch(msg.server);
          ws.watching = msg.server;
        }
        send(ws, {
          type: 'history',
          server: msg.server,
          now: Date.now(),
          samples: statsPoller.getHistory(msg.server),
        });
        break;
      }

      case 'unwatch':
        stopWatching();
        break;

      case 'restart': {
        if (!authorize(ws, msg.server, 'admin')) break;
        const result = processManager.restart(msg.server);
        if (!result.ok) send(ws, { type: 'error', error: result.error });
        break;
      }

      case 'set_ram': {
        if (!authorize(ws, msg.server, 'admin')) break;
        // null/blank clears the override and falls back to start.bat/
        // run.bat/plain java — see serverConfig.js and the comment on
        // buildLaunchCommand for what that tradeoff means.
        let ramMB = null;
        if (msg.ramMB !== null && msg.ramMB !== '' && msg.ramMB !== undefined) {
          ramMB = Number(msg.ramMB);
          if (!Number.isFinite(ramMB) || ramMB < 512 || ramMB > 65536) {
            send(ws, { type: 'error', error: 'RAM must be between 512 and 65536 MB' });
            break;
          }
        }
        serverConfig.setRamMB(path.join(SERVERS_DIR, msg.server), ramMB);
        broadcastServerList();
        break;
      }

      case 'set_port': {
        if (!authorize(ws, msg.server, 'admin')) break;
        const port = Number(msg.port);
        if (!Number.isInteger(port) || port < 1 || port > 65535) {
          send(ws, { type: 'error', error: 'Port must be between 1 and 65535' });
          break;
        }
        serverConfig.setPort(path.join(SERVERS_DIR, msg.server), port);
        broadcastServerList();
        break;
      }

      case 'get_players': {
        if (!authorize(ws, msg.server)) break;
        send(ws, {
          type: 'known_players',
          server: msg.server,
          players: players.knownPlayers(path.join(SERVERS_DIR, msg.server)),
        });
        break;
      }

      case 'get_player': {
        if (!authorize(ws, msg.server)) break;
        players.readPlayer(path.join(SERVERS_DIR, msg.server), String(msg.uuid))
          .then((data) => {
            if (!data) return send(ws, { type: 'error', error: 'Invalid player id' });
            send(ws, { type: 'player_detail', server: msg.server, uuid: msg.uuid, data });
          })
          .catch((err) => send(ws, { type: 'error', error: err.message }));
        break;
      }

      default:
        send(ws, { type: 'error', error: `Unknown message type: ${msg.type}` });
    }
  });

  ws.on('close', () => {
    console.log('Client disconnected');
    stopWatching();
    clients.delete(ws);
  });
});

httpServer.listen(PORT, () => {
  console.log(`Scanning for servers in: ${SERVERS_DIR}`);
  console.log(`Found: ${currentServerList().map(s => s.name).join(', ') || '(none)'}`);
  console.log(`Host agent listening on http://localhost:${PORT}`);
  console.log(`  HTTP status check: http://localhost:${PORT}/status`);
  console.log(`  WebSocket:         ws://localhost:${PORT}/ws?token=<token>`);
  console.log('Tokens loaded:');
  for (const t of TOKENS) {
    const d = auth.describe(t);
    console.log(`  ${d.label}: servers=${d.servers === '*' ? '*' : d.servers.join(',')} console=${d.console} admin=${d.admin}`);
  }
  statsPoller.start();
});