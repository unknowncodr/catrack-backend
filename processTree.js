// Finds every descendant PID of a launcher process.
//
// Why this exists: on Windows, processManager launches servers via
// `cmd.exe /c start.bat` (when a start.bat/run.bat is present), and
// that batch file runs `java` as a CHILD of cmd.exe. If we only sample
// the PID we spawned (cmd.exe), pidusage reports cmd.exe's own near-
// zero usage — not java's real CPU/RAM, which is what people actually
// want to see. Same issue can happen on Linux/macOS if a start script
// wraps java through a shell.
//
// So instead: build a full process table (pid -> parent pid), then
// walk down from the root pid we spawned to collect every descendant
// (children, grandchildren, ...) and sum usage across all of them.

const { exec } = require('child_process');

function listProcessesWindows() {
  return new Promise((resolve, reject) => {
    // CIM is the modern, non-deprecated replacement for wmic (which
    // Microsoft has been phasing out) and ships with PowerShell on
    // every supported Windows version.
    const cmd = 'powershell -NoProfile -NonInteractive -Command '
      + '"Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId | ConvertTo-Json -Compress"';
    exec(cmd, { maxBuffer: 16 * 1024 * 1024, windowsHide: true }, (err, stdout) => {
      if (err) return reject(err);
      try {
        let data = JSON.parse(stdout);
        if (!Array.isArray(data)) data = [data]; // PowerShell unwraps single-item arrays
        resolve(data.map(p => ({ pid: p.ProcessId, ppid: p.ParentProcessId })));
      } catch (parseErr) {
        reject(parseErr);
      }
    });
  });
}

function listProcessesPosix() {
  return new Promise((resolve, reject) => {
    exec('ps -eo pid,ppid', (err, stdout) => {
      if (err) return reject(err);
      const lines = stdout.trim().split('\n').slice(1); // drop header
      const out = [];
      for (const line of lines) {
        const parts = line.trim().split(/\s+/);
        const pid = parseInt(parts[0], 10);
        const ppid = parseInt(parts[1], 10);
        if (Number.isFinite(pid) && Number.isFinite(ppid)) out.push({ pid, ppid });
      }
      resolve(out);
    });
  });
}

function listProcesses() {
  return process.platform === 'win32' ? listProcessesWindows() : listProcessesPosix();
}

// Returns [rootPid, ...all descendants]. On any failure (e.g. the
// process table couldn't be read), falls back to just [rootPid] so
// callers still get *something* rather than erroring out entirely.
async function descendantPids(rootPid) {
  try {
    const all = await listProcesses();
    const byParent = new Map();
    for (const p of all) {
      if (!byParent.has(p.ppid)) byParent.set(p.ppid, []);
      byParent.get(p.ppid).push(p.pid);
    }

    const seen = new Set([rootPid]);
    const queue = [rootPid];
    while (queue.length) {
      const pid = queue.shift();
      for (const child of byParent.get(pid) || []) {
        if (!seen.has(child)) {
          seen.add(child);
          queue.push(child);
        }
      }
    }
    return Array.from(seen);
  } catch {
    return [rootPid];
  }
}

module.exports = { descendantPids };
