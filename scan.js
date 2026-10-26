// Scans the servers directory (one level up from host-agent, i.e. the
// mc-servers folder that contains host-agent/ alongside each server's
// own folder) and builds the server list the frontend displays.

const fs = require('fs');
const path = require('path');
const AdmZip = require('adm-zip');
const { getRamMB } = require('./serverConfig');

// host-agent lives *inside* the servers folder, so its parent is where
// all the individual server folders sit as siblings of host-agent.
const SERVERS_DIR = path.join(__dirname, '..');

// Reads server.properties and pulls out server-port. Falls back to the
// Minecraft default (25565) if the file is missing or the key isn't set.
function readPort(serverPath) {
  const propsPath = path.join(serverPath, 'server.properties');
  if (!fs.existsSync(propsPath)) return 25565;

  const lines = fs.readFileSync(propsPath, 'utf8').split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('server-port=')) {
      const value = trimmed.split('=')[1]?.trim();
      const port = parseInt(value, 10);
      if (!isNaN(port)) return port;
    }
  }
  return 25565;
}

// Vanilla and Paper server jars both ship a version.json at the root of
// the jar (this has been true since 1.14) with the version under
// "name" or "id". We read it straight out of the jar without extracting
// anything to disk.
function readVersion(serverPath) {
  const jarPath = path.join(serverPath, 'server.jar');
  if (!fs.existsSync(jarPath)) return 'unknown';

  try {
    const zip = new AdmZip(jarPath);
    const entry = zip.getEntry('version.json');
    if (!entry) return 'unknown';

    const data = JSON.parse(entry.getData().toString('utf8'));
    return data.name || data.id || 'unknown';
  } catch (err) {
    console.log(`Could not read version from ${jarPath}:`, err.message);
    return 'unknown';
  }
}

// A folder counts as a server if it directly contains a server.jar.
// This deliberately skips host-agent itself and any other non-server
// folder (backups, etc.) sitting alongside the servers.
//
// isRunningFn(name) -> boolean lets the caller report live status from
// the process manager instead of always saying 'offline'.
function scanServers(isRunningFn = () => false) {
  const entries = fs.readdirSync(SERVERS_DIR, { withFileTypes: true });
  const servers = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;

    const serverPath = path.join(SERVERS_DIR, entry.name);
    const jarPath = path.join(serverPath, 'server.jar');
    if (!fs.existsSync(jarPath)) continue;

    servers.push({
      name: entry.name,
      version: readVersion(serverPath),
      port: readPort(serverPath),
      ramMB: getRamMB(serverPath), // null = no override, using start.bat/run.bat/plain java
      status: isRunningFn(entry.name) ? 'online' : 'offline',
    });
  }

  return servers;
}

module.exports = { scanServers, SERVERS_DIR };
