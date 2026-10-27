// Minimal Minecraft "Server List Ping" (SLP) client.
//
// This is the exact same handshake the vanilla multiplayer server list
// uses to show player counts and the little server icon next to each
// entry. It works against ANY server version >= 1.7 with zero setup on
// the server side — no query.enabled, no RCON, no plugins/mods needed.
//
// Protocol (post-1.7, "status" flow):
//   1. Open a TCP socket to the server's game port.
//   2. Send a Handshake packet (id 0x00) with next_state = 1 (status).
//   3. Send an empty Status Request packet (id 0x00).
//   4. Read back a Status Response packet (id 0x00) containing a JSON
//      string with version, players, description (MOTD) and an
//      optional base64 "favicon" (the server icon).
//
// All multi-byte packet/string lengths use VarInts, hence the encode/
// decode helpers below.

const net = require('net');

function encodeVarInt(value) {
  const bytes = [];
  let v = value;
  do {
    let temp = v & 0b01111111;
    v >>>= 7;
    if (v !== 0) temp |= 0b10000000;
    bytes.push(temp);
  } while (v !== 0);
  return Buffer.from(bytes);
}

function encodeString(str) {
  const strBuf = Buffer.from(str, 'utf8');
  return Buffer.concat([encodeVarInt(strBuf.length), strBuf]);
}

function encodeUShort(value) {
  const buf = Buffer.alloc(2);
  buf.writeUInt16BE(value, 0);
  return buf;
}

// Wraps a packet body with its own length-prefix VarInt, per the
// Minecraft protocol framing (every packet is [VarInt length][data]).
function framePacket(body) {
  return Buffer.concat([encodeVarInt(body.length), body]);
}

// Reads a VarInt out of a buffer starting at `offset`. Returns
// {value, length} or null if the buffer doesn't yet contain a
// complete VarInt (caller should wait for more data).
function readVarInt(buf, offset) {
  let value = 0;
  let position = 0;
  let currentOffset = offset;

  while (true) {
    if (currentOffset >= buf.length) return null;
    const byte = buf[currentOffset++];
    value |= (byte & 0x7f) << position;
    if ((byte & 0x80) === 0) break;
    position += 7;
    if (position >= 32) throw new Error('VarInt too big');
  }
  return { value, length: currentOffset - offset };
}

const DEFAULT_TIMEOUT_MS = 3000;

// Pings a single server and resolves with:
//   { online, max, sample: [{name, id}], motd, favicon, versionName }
// or rejects if the server didn't respond within the timeout (e.g.
// it's still starting up, or isn't listening on that port yet).
function ping(host, port, timeoutMs = DEFAULT_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host, port });
    let settled = false;
    let recvBuf = Buffer.alloc(0);

    const finish = (err, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (err) reject(err); else resolve(result);
    };

    const timer = setTimeout(() => finish(new Error('Ping timed out')), timeoutMs);

    socket.once('error', (err) => finish(err));

    socket.once('connect', () => {
      const protocolVersion = -1; // let the server report its own version
      const handshakeBody = Buffer.concat([
        encodeVarInt(0x00),
        encodeVarInt(protocolVersion),
        encodeString(host),
        encodeUShort(port),
        encodeVarInt(1), // next state: 1 = status
      ]);
      const statusRequestBody = encodeVarInt(0x00);

      socket.write(framePacket(handshakeBody));
      socket.write(framePacket(statusRequestBody));
    });

    socket.on('data', (chunk) => {
      recvBuf = Buffer.concat([recvBuf, chunk]);

      // Try to pull a complete framed packet out of what we have so far.
      const packetLen = readVarInt(recvBuf, 0);
      if (!packetLen) return; // need more data
      const totalNeeded = packetLen.length + packetLen.value;
      if (recvBuf.length < totalNeeded) return; // still need more data

      let cursor = packetLen.length;
      const packetId = readVarInt(recvBuf, cursor);
      if (!packetId) return finish(new Error('Malformed status response'));
      cursor += packetId.length;

      if (packetId.value !== 0x00) {
        return finish(new Error(`Unexpected packet id ${packetId.value}`));
      }

      const jsonLen = readVarInt(recvBuf, cursor);
      if (!jsonLen) return finish(new Error('Malformed status response'));
      cursor += jsonLen.length;

      const jsonStr = recvBuf.slice(cursor, cursor + jsonLen.value).toString('utf8');

      let data;
      try {
        data = JSON.parse(jsonStr);
      } catch (err) {
        return finish(new Error('Could not parse status JSON'));
      }

      const description = data.description;
      const motd = typeof description === 'string'
        ? description
        : (description && (description.text || (description.extra || []).map(p => p.text || '').join(''))) || '';

      finish(null, {
        online: (data.players && data.players.online) ?? 0,
        max: (data.players && data.players.max) ?? 0,
        sample: (data.players && data.players.sample) || [],
        motd,
        favicon: data.favicon || null,
        versionName: (data.version && data.version.name) || null,
      });
    });
  });
}

module.exports = { ping };
