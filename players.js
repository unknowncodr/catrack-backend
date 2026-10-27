// Reads player info straight from the server's files.
const fs = require('fs');
const path = require('path');
const nbt = require('prismarine-nbt');

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

function firstExisting(paths) {
  return paths.find((p) => fs.existsSync(p)) || null;
}

function worldDir(serverPath) {
  let level = 'world';
  try {
    const line = fs.readFileSync(path.join(serverPath, 'server.properties'), 'utf8')
      .split('\n').find((l) => l.trim().startsWith('level-name='));
    if (line) level = line.trim().slice('level-name='.length) || 'world';
  } catch { /* use default */ }
  return path.join(serverPath, level);
}

// Everyone the server has seen recently (usercache.json).
function knownPlayers(serverPath) {
  const cache = readJson(path.join(serverPath, 'usercache.json'), []);
  return cache.map((p) => ({ name: p.name, uuid: p.uuid }));
}

// Only plain numbers and strings are copied out of the NBT, so the
// result is always safe to JSON.stringify (no BigInt surprises).
function simplifyItems(list) {
  return (Array.isArray(list) ? list : [])
    .filter((it) => it && typeof it.id === 'string')
    .map((it) => ({
      slot: it.Slot,
      id: it.id,
      count: it.count ?? it.Count ?? 1, // 'count' since 1.20.5, 'Count' before
    }));
}

async function readPlayer(serverPath, uuid) {
  if (!/^[0-9a-f-]{32,36}$/i.test(uuid)) return null; // also blocks path tricks
  const world = worldDir(serverPath);

  // Second path in each list is the newer 26.x layout.
  const datFile = firstExisting([
    path.join(world, 'playerdata', `${uuid}.dat`),
    path.join(world, 'players', 'data', `${uuid}.dat`),
  ]);
  const statsFile = firstExisting([
    path.join(world, 'stats', `${uuid}.json`),
    path.join(world, 'players', 'stats', `${uuid}.json`),
  ]);

  const out = { uuid, hasData: false, stats: null, inventory: [], enderchest: [] };

  if (datFile) {
    try {
      const { parsed } = await nbt.parse(fs.readFileSync(datFile));
      const d = nbt.simplify(parsed);
      out.hasData = true;
      out.pos = d.Pos || null;
      out.dimension = d.Dimension || null;
      out.death = d.LastDeathLocation
        ? { dimension: d.LastDeathLocation.dimension, pos: d.LastDeathLocation.pos }
        : null;
      out.health = d.Health ?? null;
      out.food = d.foodLevel ?? null;
      out.xpLevel = d.XpLevel ?? null;
      out.gameMode = d.playerGameType ?? null;

      // Slots: 0-8 hotbar, 9-35 main inventory, 100 boots, 101 leggings,
      // 102 chestplate, 103 helmet, -106 offhand.
      out.inventory = simplifyItems(d.Inventory);
      out.enderchest = simplifyItems(d.EnderItems);

      // Newer versions may keep armor/offhand in an `equipment` compound.
      if (d.equipment && typeof d.equipment === 'object') {
        const map = { feet: 100, legs: 101, chest: 102, head: 103, offhand: -106 };
        for (const [key, slot] of Object.entries(map)) {
          const it = d.equipment[key];
          if (it && typeof it.id === 'string' && !out.inventory.some((x) => x.slot === slot)) {
            out.inventory.push({ slot, id: it.id, count: it.count ?? it.Count ?? 1 });
          }
        }
      }
    } catch (err) {
      console.log(`Could not read ${datFile}:`, err.message);
    }
  }

  if (statsFile) {
    const c = (readJson(statsFile, {}).stats || {})['minecraft:custom'] || {};
    out.stats = {
      playTimeTicks: c['minecraft:play_time'] ?? c['minecraft:play_one_minute'] ?? 0,
      deaths: c['minecraft:deaths'] ?? 0,
      mobKills: c['minecraft:mob_kills'] ?? 0,
      playerKills: c['minecraft:player_kills'] ?? 0,
      jumps: c['minecraft:jump'] ?? 0,
      walkCm: c['minecraft:walk_one_cm'] ?? 0,
    };
  }

  // So the dashboard can show Ban vs Unban, Op vs Deop, etc.
  const has = (file) => readJson(path.join(serverPath, file), [])
    .some((e) => String(e.uuid).toLowerCase() === uuid.toLowerCase());
  out.flags = { op: has('ops.json'), banned: has('banned-players.json'), whitelisted: has('whitelist.json') };

  return out;
}

module.exports = { knownPlayers, readPlayer };