// Periodically gathers the "live" stats the dashboard shows for each
// running server — player count/names, server icon, CPU/RAM, uptime,
// and TPS/MSPT (via vanilla's `tick query`, 1.20.3+) — and emits one
// 'stats' event per server per tick. server.js broadcasts each of
// these to clients.
//
// Also keeps a short rolling history per server (for the dashboard
// graphs), and only polls TPS for servers somebody is actually looking
// at (watch()/unwatch()), so `tick query` output doesn't pile up in
// every server's log around the clock.

const EventEmitter = require('events');
const pidusage = require('pidusage');
const mcping = require('./mcping');
const { descendantPids } = require('./processTree');

const { exec } = require('child_process');

// Windows: wmic is gone on newer builds, so read per-process CPU/RAM
// through PowerShell/CIM instead (same approach as processTree.js).
function sampleUsageWindows(pids) {
  return new Promise((resolve) => {
    const list = pids.join(',');
    const cmd = 'powershell -NoProfile -NonInteractive -Command '
      + `"Get-CimInstance Win32_PerfFormattedData_PerfProc_Process | `
      + `Where-Object { @(${list}) -contains $_.IDProcess } | `
      + `Select-Object PercentProcessorTime,WorkingSetPrivate | ConvertTo-Json -Compress"`;
    exec(cmd, { windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
      if (err || !stdout.trim()) return resolve(null);
      try {
        let rows = JSON.parse(stdout);
        if (!Array.isArray(rows)) rows = [rows];
        const cpu = rows.reduce((s, r) => s + (r.PercentProcessorTime || 0), 0);
        const mem = rows.reduce((s, r) => s + (r.WorkingSetPrivate || 0), 0);
        resolve({
          cpu: Math.round(cpu * 10) / 10,
          memoryMB: Math.round(mem / 1024 / 1024),
        });
      } catch {
        resolve(null);
      }
    });
  });
}

const DEFAULT_INTERVAL_MS = 4000;
const PING_TIMEOUT_MS = 2500;

// ~15 minutes of samples at the default 4s interval.
const MAX_HISTORY = 225;

// Vanilla `/tick query` (1.20.3+) replies with lines like:
//   The game is running normally
//   Target tick rate: 20.0 per second
//   Average time per tick: 2.1ms (Target: 50.0ms)
//   Percentiles: P50: 1.8ms P95: 3.2ms P99: 5.1ms, sample: 100
// Group 1 = average ms per tick. Group 2 matches the reply older
// servers give for an unknown command, so we can stop asking them.
const TICK_REGEX = /Average time per tick:\s*([\d.]+)\s*ms|(Unknown or incomplete command)/i;

// Lines that belong to the `tick query` reply. processManager hides
// matching lines from the dashboard console for a moment after each
// poll so they don't flood it.
const TICK_QUIET_REGEX = /tick rate|per tick|Percentiles|running normally|game is (frozen|sprinting|stepping)|Unknown or incomplete command|<--\[HERE\]/i;

class StatsPoller extends EventEmitter {
  // currentServerListFn() must return the same shape as scanServers():
  // [{name, version, port, status}, ...]
  constructor(processManager, currentServerListFn, tpsConfig = {}) {
    super();
    this.processManager = processManager;
    this.currentServerListFn = currentServerListFn;
    this.tpsConfig = {
      enabled: false,
      command: 'tick query',
      intervalMs: 5000,
      ...tpsConfig,
    };
    this.timer = null;
    this.lastTpsPoll = new Map();  // name -> timestamp
    this.watchCounts = new Map();  // name -> number of clients viewing it
    this.history = new Map();      // name -> { startedAt, samples: [] }
    this.tickState = new Map();    // name -> { startedAt, unsupported }
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

  // A client opened this server's detail view.
  watch(name) {
    const n = this.watchCounts.get(name) || 0;
    if (n === 0) this.lastTpsPoll.delete(name); // poll TPS right away
    this.watchCounts.set(name, n + 1);
  }

  unwatch(name) {
    const n = (this.watchCounts.get(name) || 0) - 1;
    if (n <= 0) this.watchCounts.delete(name);
    else this.watchCounts.set(name, n);
  }

  getHistory(name) {
    const h = this.history.get(name);
    return h ? h.samples : [];
  }

  record(name, startedAt, sample) {
    let h = this.history.get(name);
    // New process (restart) = fresh history.
    if (!h || h.startedAt !== startedAt) {
      h = { startedAt, samples: [] };
      this.history.set(name, h);
    }
    h.samples.push(sample);
    if (h.samples.length > MAX_HISTORY) h.samples.shift();
  }

  async tick() {
    const servers = this.currentServerListFn().filter(s => s.status === 'online');

    // Forget history of servers that are no longer running.
    const onlineNames = new Set(servers.map(s => s.name));
    for (const name of this.history.keys()) {
      if (!onlineNames.has(name)) this.history.delete(name);
    }

    await Promise.all(servers.map((s) => this.pollOne(s)));
  }

  async pollOne(server) {
    const { name, port } = server;
    const info = this.processManager.getRunningInfo(name);
    if (!info) return; // stopped between the scan and now

    const uptimeMs = Date.now() - info.startedAt;

    // `tick` is one of:
    //   undefined -> no new TPS data this tick (keep the old value)
    //   null      -> TPS unavailable (disabled / unsupported / no reply)
    //   {tps, mspt}
    const [pingResult, usage, tick] = await Promise.all([
      mcping.ping('127.0.0.1', port, PING_TIMEOUT_MS).catch(() => null),
      this.sampleUsage(info.pid),
      this.maybePollTps(name, info),
    ]);

    this.record(name, info.startedAt, {
      t: Date.now(),
      cpu: usage ? usage.cpu : null,
      memoryMB: usage ? usage.memoryMB : null,
      tps: tick ? tick.tps : null,
      mspt: tick ? tick.mspt : null,
    });

    this.emit('stats', {
      server: name,
      data: {
        uptimeMs,
        cpu: usage ? usage.cpu : null,
        memoryMB: usage ? usage.memoryMB : null,
        players: pingResult
          ? {
            online: pingResult.online,
            max: pingResult.max,
            sample: pingResult.sample.map((player) => (
              player && typeof player === 'object'
                ? { ...player, uuid: player.uuid ?? player.id }
                : player
            )),
          }
          : null,
        icon: pingResult ? pingResult.favicon : null,
        motd: pingResult ? pingResult.motd : null,
        // undefined keys vanish in JSON, so the frontend keeps its old value.
        tps: tick ? tick.tps : tick,
        mspt: tick ? tick.mspt : tick,
      },
    });
  }

  // Sums CPU/RAM across the launcher process AND all of its
  // descendants (see processTree.js for why — the process we actually
  // spawned is often just a cmd.exe/start.bat wrapper, and the real
  // java process using the CPU/RAM is a child or grandchild of it).
  async sampleUsage(rootPid) {
    const pids = await descendantPids(rootPid);

    if (process.platform === 'win32') {
      return sampleUsageWindows(pids);
    }

    let stats;
    try {
      stats = await pidusage(pids);
    } catch (err) {
      console.log('[stats] pidusage failed:', err.message);
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

  // Runs `tick query` on its own cadence, and only for servers that
  // at least one client is currently watching. TPS is capped at 20:
  // a tick faster than 50ms just waits out the rest of its slot.
  async maybePollTps(name, info) {
    if (!this.tpsConfig.enabled) return null;
    if (!(this.watchCounts.get(name) > 0)) return undefined;

    // Server told us it doesn't know `tick` (older than 1.20.3) —
    // don't ask again until it's restarted.
    const state = this.tickState.get(name);
    if (state && state.startedAt === info.startedAt && state.unsupported) return null;

    const last = this.lastTpsPoll.get(name) || 0;
    if (Date.now() - last < this.tpsConfig.intervalMs) return undefined;
    this.lastTpsPoll.set(name, Date.now());

    const match = await this.processManager.queryConsole(
      name, this.tpsConfig.command, TICK_REGEX, 2000, TICK_QUIET_REGEX);
    if (!match) return null;

    if (match[2]) {
      this.tickState.set(name, { startedAt: info.startedAt, unsupported: true });
      return null;
    }

    const mspt = parseFloat(match[1]);
    if (!Number.isFinite(mspt)) return null;
    return { mspt, tps: mspt <= 50 ? 20 : 1000 / mspt };
  }
}

module.exports = StatsPoller;