// Periodically gathers the "live" stats the dashboard shows for each
// running server — player count/names, server icon, CPU/RAM, uptime,
// and (best-effort, if enabled) TPS — and emits one 'stats' event per
// server per tick. server.js broadcasts each of these to clients.

const EventEmitter = require('events');
const pidusage = require('pidusage');
const mcping = require('./mcping');
const { descendantPids } = require('./processTree');

const DEFAULT_INTERVAL_MS = 4000;
const PING_TIMEOUT_MS = 2500;

// Matches the first number after "TPS" + ":" in a console line, which
// covers Paper/Spigot's `/tps` ("TPS from last 1m, 5m, 15m: 20.0, ..."),
// Forge's `/forge tps` ("... Mean TPS: 20.000"), and Spark's `/spark tps`
// output. Anything that doesn't match this shape (including vanilla's
// "Unknown command" reply) is treated as "TPS unavailable".
const TPS_REGEX = /TPS[^:]*:\s*\*?(-?[\d.]+)/i;

class StatsPoller extends EventEmitter {
  // currentServerListFn() must return the same shape as scanServers():
  // [{name, version, port, status}, ...]
  constructor(processManager, currentServerListFn, tpsConfig = {}) {
    super();
    this.processManager = processManager;
    this.currentServerListFn = currentServerListFn;
    this.tpsConfig = {
      enabled: false,
      command: 'tps',
      intervalMs: 10000,
      ...tpsConfig,
    };
    this.timer = null;
    this.lastTpsPoll = new Map(); // name -> timestamp
  }

  start(intervalMs = DEFAULT_INTERVAL_MS) {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick(), intervalMs);
    this.tick();
  }

  stop() {
    clearInterval(this.timer);
    this.timer = null;
  }

  async tick() {
    const servers = this.currentServerListFn().filter(s => s.status === 'online');

    await Promise.all(servers.map((s) => this.pollOne(s)));
  }

  async pollOne(server) {
    const { name, port } = server;
    const info = this.processManager.getRunningInfo(name);
    if (!info) return; // stopped between the scan and now

    const uptimeMs = Date.now() - info.startedAt;

    const [pingResult, usage, tps] = await Promise.all([
      mcping.ping('127.0.0.1', port, PING_TIMEOUT_MS).catch(() => null),
      this.sampleUsage(info.pid),
      this.maybePollTps(name),
    ]);

    this.emit('stats', {
      server: name,
      data: {
        uptimeMs,
        cpu: usage ? usage.cpu : null,
        memoryMB: usage ? usage.memoryMB : null,
        players: pingResult
          ? { online: pingResult.online, max: pingResult.max, sample: pingResult.sample }
          : null,
        icon: pingResult ? pingResult.favicon : null,
        motd: pingResult ? pingResult.motd : null,
        tps,
      },
    });
  }

  // Sums CPU/RAM across the launcher process AND all of its
  // descendants (see processTree.js for why — the process we actually
  // spawned is often just a cmd.exe/start.bat wrapper, and the real
  // java process using the CPU/RAM is a child or grandchild of it).
  async sampleUsage(rootPid) {
    const pids = await descendantPids(rootPid);
    let stats;
    try {
      stats = await pidusage(pids);
    } catch {
      return null;
    }
    // pidusage(array) always resolves to {pid: statsOrNull, ...}, even
    // for a single-element array — normalize and drop any pid that
    // had already exited by the time we sampled it.
    const entries = Object.values(stats).filter(Boolean);
    if (!entries.length) return null;

    const cpu = entries.reduce((sum, s) => sum + s.cpu, 0);
    const memoryBytes = entries.reduce((sum, s) => sum + s.memory, 0);
    return {
      cpu: Math.round(cpu * 10) / 10,
      memoryMB: Math.round(memoryBytes / 1024 / 1024),
    };
  }

  // Only actually sends the TPS command on its own (slower) cadence,
  // since it writes to the server's stdin and we don't want to spam a
  // command every 4 seconds. Returns null immediately if TPS polling
  // is disabled (the default — see the comment on TPS_POLLING in
  // server.js for how to turn it on).
  async maybePollTps(name) {
    if (!this.tpsConfig.enabled) return null;

    const last = this.lastTpsPoll.get(name) || 0;
    if (Date.now() - last < this.tpsConfig.intervalMs) return undefined; // "no new data this tick"

    this.lastTpsPoll.set(name, Date.now());
    const match = await this.processManager.queryConsole(name, this.tpsConfig.command, TPS_REGEX, 2000);
    if (!match) return null;
    const value = parseFloat(match[1]);
    return Number.isFinite(value) ? value : null;
  }
}

module.exports = StatsPoller;
