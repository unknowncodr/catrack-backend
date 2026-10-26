// Tracks running server processes, captures their console output, and lets
// the caller send commands back in via stdin. Emits 'console' and
// 'status_change' events that server.js broadcasts to connected clients.

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const EventEmitter = require('events');
const { getRamMB } = require('./serverConfig');

const MAX_LOG_LINES = 500;

class ProcessManager extends EventEmitter {
  constructor(serversDir) {
    super();
    this.serversDir = serversDir;
    this.processes = new Map(); // name -> { proc, logs: [] }
  }

  isRunning(name) {
    return this.processes.has(name);
  }

  getLogs(name) {
    const entry = this.processes.get(name);
    return entry ? entry.logs : [];
  }

  // pid + startedAt for whichever servers are currently running, so the
  // stats poller can sample CPU/RAM and compute uptime without reaching
  // into internals.
  getRunningInfo(name) {
    const entry = this.processes.get(name);
    if (!entry) return null;
    return { pid: entry.proc.pid, startedAt: entry.startedAt };
  }

  getAllRunning() {
    const out = [];
    for (const [name, entry] of this.processes) {
      out.push({ name, pid: entry.proc.pid, startedAt: entry.startedAt });
    }
    return out;
  }

  // Sends a console command and resolves with the first subsequent
  // console line matching `regex`, or resolves null if nothing matches
  // within timeoutMs. Used to pull TPS out of servers whose software
  // exposes it via a command (e.g. Paper/Spigot/Forge, or a Fabric mod
  // like Spark) — vanilla/Fabric with no such mod will just time out
  // and resolve null, which is expected and handled upstream.
  queryConsole(name, command, regex, timeoutMs = 2000) {
    const entry = this.processes.get(name);
    if (!entry) return Promise.resolve(null);

    return new Promise((resolve) => {
      let settled = false;
      const matcher = {
        regex,
        onMatch: (match) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          const idx = entry.pendingMatchers.indexOf(matcher);
          if (idx !== -1) entry.pendingMatchers.splice(idx, 1);
          resolve(match);
        },
      };
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        const idx = entry.pendingMatchers.indexOf(matcher);
        if (idx !== -1) entry.pendingMatchers.splice(idx, 1);
        resolve(null);
      }, timeoutMs);

      entry.pendingMatchers.push(matcher);
      entry.proc.stdin.write(command + '\n');
    });
  }

  // Prefer an existing start.bat/run.bat in the server's own folder (it
  // likely already has memory flags and other settings tuned) and only
  // fall back to a plain launch if neither exists.
  //
  // If a RAM override has been set from the dashboard, that takes
  // priority and launches java directly with -Xmx/-Xms — which means
  // any *other* flags baked into an existing start.bat/run.bat (GC
  // tuning, Aikar's flags, etc.) get bypassed for as long as the
  // override is set. Clearing the override (leave the RAM field blank
  // in the dashboard) goes back to using the bat file as-is.
  buildLaunchCommand(serverPath, ramMB) {
    if (ramMB) {
      return { command: 'java', args: [`-Xmx${ramMB}M`, `-Xms${ramMB}M`, '-jar', 'server.jar', 'nogui'] };
    }
    if (fs.existsSync(path.join(serverPath, 'start.bat'))) {
      return { command: 'cmd.exe', args: ['/c', 'start.bat'] };
    }
    if (fs.existsSync(path.join(serverPath, 'run.bat'))) {
      return { command: 'cmd.exe', args: ['/c', 'run.bat'] };
    }
    return { command: 'java', args: ['-jar', 'server.jar', 'nogui'] };
  }

  start(name) {
    if (this.processes.has(name)) {
      return { ok: false, error: 'Already running' };
    }

    const serverPath = path.join(this.serversDir, name);
    if (!fs.existsSync(serverPath)) {
      return { ok: false, error: 'Server folder not found' };
    }

    const ramMB = getRamMB(serverPath);
    const { command, args } = this.buildLaunchCommand(serverPath, ramMB);
    const proc = spawn(command, args, { cwd: serverPath });

    const entry = { proc, logs: [], startedAt: Date.now(), pendingMatchers: [] };
    this.processes.set(name, entry);

    const pushLine = (line) => {
      entry.logs.push(line);
      if (entry.logs.length > MAX_LOG_LINES) entry.logs.shift();
      this.emit('console', { server: name, line });

      // Give any in-flight queryConsole() calls a chance to claim this
      // line before it's just treated as normal console output.
      for (const matcher of entry.pendingMatchers.slice()) {
        const match = line.match(matcher.regex);
        if (match) matcher.onMatch(match);
      }
    };

    proc.stdout.on('data', (data) => {
      data.toString().split('\n').map(l => l.trimEnd()).filter(Boolean).forEach(pushLine);
    });
    proc.stderr.on('data', (data) => {
      data.toString().split('\n').map(l => l.trimEnd()).filter(Boolean).forEach(pushLine);
    });

    proc.on('error', (err) => {
      pushLine(`[host-agent] Failed to start: ${err.message}`);
      this.processes.delete(name);
      this.emit('status_change', { server: name, status: 'offline' });
    });

    proc.on('exit', (code) => {
      pushLine(`[host-agent] Process exited with code ${code}`);
      const wasRestarting = entry.restarting;
      this.processes.delete(name);
      this.emit('status_change', { server: name, status: 'offline' });

      if (wasRestarting) {
        pushLine('[host-agent] Restarting...');
        setTimeout(() => this.start(name), 1000);
      }
    });

    this.emit('status_change', { server: name, status: 'online' });
    return { ok: true };
  }

  // Graceful stop: sends the "stop" console command, same as typing it
  // yourself, so the world saves properly instead of being killed.
  stop(name) {
    const entry = this.processes.get(name);
    if (!entry) return { ok: false, error: 'Not running' };
    entry.proc.stdin.write('stop\n');
    return { ok: true };
  }

  // If running: graceful stop, then start() again once the process has
  // actually exited (handled in the 'exit' listener above). If it's
  // already offline, restart is just a start.
  restart(name) {
    const entry = this.processes.get(name);
    if (!entry) return this.start(name);
    entry.restarting = true;
    entry.proc.stdin.write('stop\n');
    return { ok: true };
  }

  sendCommand(name, command) {
    const entry = this.processes.get(name);
    if (!entry) return { ok: false, error: 'Not running' };
    entry.proc.stdin.write(command + '\n');
    return { ok: true };
  }
}

module.exports = ProcessManager;
