// Small per-server overrides the dashboard lets you edit directly:
//
//   - Allocated RAM: not something server.properties tracks, so it's
//     stored in a tiny agent-managed file inside the server's own
//     folder. When set, processManager launches that server with an
//     explicit -Xmx/-Xms instead of whatever start.bat/run.bat would
//     have used — see the comment on buildLaunchCommand for the
//     tradeoff that comes with that.
//   - Port: written straight into server.properties, which is the
//     actual source of truth Minecraft itself reads on startup.

const fs = require('fs');
const path = require('path');

function configFile(serverPath) {
  return path.join(serverPath, '.host-agent.json');
}

function readConfig(serverPath) {
  const file = configFile(serverPath);
  if (!fs.existsSync(file)) return {};
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return {};
  }
}

function getRamMB(serverPath) {
  const data = readConfig(serverPath);
  return typeof data.ramMB === 'number' ? data.ramMB : null;
}

// Pass ramMB = null to clear the override and fall back to
// start.bat/run.bat/plain-java launch behavior.
function setRamMB(serverPath, ramMB) {
  const data = readConfig(serverPath);
  if (ramMB == null) {
    delete data.ramMB;
  } else {
    data.ramMB = ramMB;
  }

  const file = configFile(serverPath);
  if (Object.keys(data).length === 0) {
    if (fs.existsSync(file)) fs.unlinkSync(file);
  } else {
    fs.writeFileSync(file, JSON.stringify(data, null, 2));
  }
}

// Rewrites (or adds) the server-port line in server.properties. Takes
// effect the next time the server starts — Minecraft doesn't reread
// this file while running.
function setPort(serverPath, port) {
  const propsPath = path.join(serverPath, 'server.properties');
  let lines = [];
  if (fs.existsSync(propsPath)) {
    lines = fs.readFileSync(propsPath, 'utf8').split('\n');
  }

  let found = false;
  lines = lines.map((line) => {
    if (line.trim().startsWith('server-port=')) {
      found = true;
      return `server-port=${port}`;
    }
    return line;
  });
  if (!found) lines.push(`server-port=${port}`);

  fs.writeFileSync(propsPath, lines.join('\n'));
}

module.exports = { getRamMB, setRamMB, setPort };
