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

// Finds the jar that represents this server. Prefers server.jar, then
// any other top-level jar that isn't a Fabric/Quilt launcher stub.
// Returns null if the folder has no usable jar (e.g. Forge servers).
function findServerJar(serverPath) {
  if (fs.existsSync(path.join(serverPath, 'server.jar'))) return 'server.jar';
  try {
    const jars = fs.readdirSync(serverPath)
      .filter((f) => f.toLowerCase().endsWith('.jar') && !/-server-launch\.jar$/i.test(f));
    return jars[0] || null;
  } catch {
    return null;
  }
}

// Modern Forge and NeoForge servers don't run from a root-level jar.
// They ship a run.bat that points at args files inside libraries/, e.g.
//   libraries/net/minecraftforge/forge/<mc>-<forge>/win_args.txt
//   libraries/net/neoforged/neoforge/<version>/win_args.txt
// So: run.bat + one of those library folders = Forge/NeoForge server.
function forgeLibraryDir(serverPath) {
  const candidates = [
    { loader: 'Forge', dir: path.join(serverPath, 'libraries', 'net', 'minecraftforge', 'forge') },
    { loader: 'NeoForge', dir: path.join(serverPath, 'libraries', 'net', 'neoforged', 'neoforge') },
  ];
  for (const c of candidates) {
    if (fs.existsSync(c.dir)) return c;
  }
  return null;
}

function isForgeServer(serverPath) {
  if (!fs.existsSync(path.join(serverPath, 'run.bat'))) return false;
  return forgeLibraryDir(serverPath) !== null;
}

// NeoForge versions look like "21.1.77" for Minecraft 1.21.1
// ("20.4.x" -> 1.20.4, "21.0.x" -> 1.21).
function neoForgeToMcVersion(version) {
  const m = version.match(/^(\d+)\.(\d+)/);
  if (!m) return null;
  return m[2] === '0' ? `1.${m[1]}` : `1.${m[1]}.${m[2]}`;
}

// Gets the Minecraft version for a Forge/NeoForge server. First tries
// the path inside run.bat (that's the version that actually gets
// launched), then falls back to listing the libraries folder.
function readForgeVersion(serverPath) {
  const lib = forgeLibraryDir(serverPath);
  if (!lib) return 'unknown';

  let versionDirName = null;

  try {
    const bat = fs.readFileSync(path.join(serverPath, 'run.bat'), 'utf8');
    const re = lib.loader === 'Forge'
      ? /libraries[\\/]net[\\/]minecraftforge[\\/]forge[\\/]([^\\/\s"]+)/i
      : /libraries[\\/]net[\\/]neoforged[\\/]neoforge[\\/]([^\\/\s"]+)/i;
    const match = bat.match(re);
    if (match) versionDirName = match[1];
  } catch { /* fall through to the directory listing */ }

  if (!versionDirName) {
    try {
      const dirs = fs.readdirSync(lib.dir, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => d.name)
        .sort();
      versionDirName = dirs[dirs.length - 1] || null;
    } catch { /* ignore */ }
  }

  if (!versionDirName) return 'unknown';

  if (lib.loader === 'Forge') {
    // "1.20.1-47.2.0" -> "1.20.1"
    return `${versionDirName.split('-')[0]} Forge`;
  }
  const mc = neoForgeToMcVersion(versionDirName);
  return mc ? `${mc} NeoForge` : `NeoForge ${versionDirName}`;
}

// Vanilla and Paper server jars both ship a version.json at the root of
// the jar (this has been true since 1.14) with the version under
// "name" or "id". We read it straight out of the jar without extracting
// anything to disk. Forge servers have no such jar, so they take the
// library-folder route instead.
function readVersion(serverPath) {
  if (isForgeServer(serverPath)) return readForgeVersion(serverPath);

  const jarName = findServerJar(serverPath);
  if (!jarName) return 'unknown';
  const jarPath = path.join(serverPath, jarName);

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

// A folder counts as a server if it contains a server jar (any name) or
// is a Forge/NeoForge server (run.bat + libraries/). This deliberately
// skips host-agent itself and any other non-server folder (backups,
// etc.) sitting alongside the servers.
//
// isRunningFn(name) -> boolean lets the caller report live status from
// the process manager instead of always saying 'offline'.
function scanServers(isRunningFn = () => false) {
  const entries = fs.readdirSync(SERVERS_DIR, { withFileTypes: true });
  const servers = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;

    const serverPath = path.join(SERVERS_DIR, entry.name);
    if (!findServerJar(serverPath) && !isForgeServer(serverPath)) continue;

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

module.exports = { scanServers, SERVERS_DIR, findServerJar, isForgeServer };