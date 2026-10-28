// Token parsing and permission checks.
//
// .env format:
//
//   # Legacy / owner token: full access to every server.
//   AGENT_TOKEN=long-random-secret
//
//   # Extra tokens: AGENT_TOKEN_<anything>=<secret>;key=value;key=value
//   AGENT_TOKEN_FRIEND=another-long-secret;servers=Survival;console=false;admin=false
//   AGENT_TOKEN_MOD=third-long-secret;servers=Survival,Creative;console=true;admin=false
//
// Properties (all optional except servers):
//   servers  comma-separated server folder names this token may see, or *
//            for all. REQUIRED: a token without it is rejected, so a typo
//            can never silently grant access to everything.
//   console  true/false (default false). Allows viewing console output and
//            sending console commands (which includes kick/ban/op/etc.).
//   admin    true/false (default false). Allows start/stop/restart and
//            changing RAM/port.

const crypto = require('crypto');

const MIN_TOKEN_LENGTH = 16;

function parseBool(v) {
  return String(v).trim().toLowerCase() === 'true';
}

// Returns { tokens: [...], warnings: [...] }
function loadTokens(env) {
  const tokens = [];
  const warnings = [];

  if (env.AGENT_TOKEN && env.AGENT_TOKEN.trim()) {
    tokens.push({
      label: 'owner',
      token: env.AGENT_TOKEN.trim(),
      servers: '*',
      console: true,
      admin: true,
    });
  }

  for (const [key, raw] of Object.entries(env)) {
    if (!key.startsWith('AGENT_TOKEN_')) continue;
    const label = key.slice('AGENT_TOKEN_'.length);
    const parts = String(raw).split(';').map((p) => p.trim()).filter(Boolean);
    const token = parts.shift();

    if (!token) {
      warnings.push(`${key}: empty token, skipped`);
      continue;
    }

    const props = {};
    for (const part of parts) {
      const eq = part.indexOf('=');
      if (eq === -1) {
        warnings.push(`${key}: ignoring "${part}" (expected key=value)`);
        continue;
      }
      props[part.slice(0, eq).trim().toLowerCase()] = part.slice(eq + 1).trim();
    }

    if (!props.servers) {
      warnings.push(`${key}: missing servers=..., token skipped (use servers=* for all)`);
      continue;
    }

    const servers = props.servers === '*'
      ? '*'
      : new Set(props.servers.split(',').map((s) => s.trim()).filter(Boolean));

    for (const k of Object.keys(props)) {
      if (!['servers', 'console', 'admin'].includes(k)) {
        warnings.push(`${key}: unknown property "${k}" ignored`);
      }
    }

    tokens.push({
      label,
      token,
      servers,
      console: parseBool(props.console),
      admin: parseBool(props.admin),
    });
  }

  for (const t of tokens) {
    if (t.token.length < MIN_TOKEN_LENGTH) {
      warnings.push(`token "${t.label}" is shorter than ${MIN_TOKEN_LENGTH} characters, consider a longer one`);
    }
  }
  const seen = new Set();
  for (const t of tokens) {
    if (seen.has(t.token)) warnings.push(`token "${t.label}" has the same secret as another token`);
    seen.add(t.token);
  }

  return { tokens, warnings };
}

function sha(s) {
  return crypto.createHash('sha256').update(String(s)).digest();
}

// Constant-time lookup. Returns the matching token entry or null.
function authenticate(tokens, given) {
  if (!given) return null;
  const givenHash = sha(given);
  let found = null;
  for (const t of tokens) {
    if (crypto.timingSafeEqual(givenHash, sha(t.token)) && !found) found = t;
  }
  return found;
}

function canSee(auth, serverName) {
  if (!auth) return false;
  return auth.servers === '*' || auth.servers.has(serverName);
}

// What the frontend needs to know to hide controls it can't use.
function describe(auth) {
  return {
    label: auth.label,
    servers: auth.servers === '*' ? '*' : Array.from(auth.servers),
    console: auth.console,
    admin: auth.admin,
  };
}

module.exports = { loadTokens, authenticate, canSee, describe };