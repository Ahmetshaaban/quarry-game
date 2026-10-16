'use strict';
/*
 * QUARRY - a small turn-based multiplayer strategy game for humans and agents.
 *
 * Zero dependencies: plain Node.js standard library HTTP server.
 * Humans play in the browser at "/", agents play over the JSON API.
 *
 * See README.md for the rules and docs/API.md (served at /api-docs) for the agent API.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = Number(process.env.PORT || 8770);
const HOST = process.env.HOST || '0.0.0.0';
const TURN_SECONDS = Number(process.env.TURN_SECONDS || 30);
const DATA_DIR = path.join(__dirname, 'data');
const MATCH_DIR = path.join(DATA_DIR, 'matches');
const PUBLIC_DIR = path.join(__dirname, 'public');

const MAX_SEATS = 4;
const TAKE_MIN = 1;
const TAKE_MAX = 2;
const SEAL_BONUS = 2;
const ROOM_TTL_MS = 24 * 60 * 60 * 1000;
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no I, O, 0, 1

const QUARRIES = [
  { id: 'ruby', label: 'Ruby', colour: '#e0555f' },
  { id: 'amber', label: 'Amber', colour: '#e2a13c' },
  { id: 'jade', label: 'Jade', colour: '#4fb07a' },
  { id: 'azure', label: 'Azure', colour: '#4a8fd4' },
];
const PER_QUARRY = 9;

// ---------------------------------------------------------------- utilities

const randomCode = () => {
  let out = '';
  for (let i = 0; i < 5; i += 1) out += CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)];
  return out;
};

const randomToken = () => crypto.randomBytes(16).toString('hex');

const clone = (value) => JSON.parse(JSON.stringify(value));

function json(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(text),
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
  });
  res.end(text);
}

const fail = (res, status, code, message) => json(res, status, { ok: false, error: code, message });

function readBody(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(Object.assign(new Error('request body too large'), { statusCode: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8').trim();
      if (!raw) return resolve({});
      try {
        const parsed = JSON.parse(raw);
        resolve(parsed && typeof parsed === 'object' ? parsed : {});
      } catch (err) {
        reject(Object.assign(new Error('request body must be JSON'), { statusCode: 400 }));
      }
    });
    req.on('error', reject);
  });
}

// ------------------------------------------------------------------- rooms

const rooms = new Map();

function newRoom(options = {}) {
  let code;
  do { code = randomCode(); } while (rooms.has(code));
  const room = {
    code,
    createdAt: Date.now(),
    phase: 'lobby',           // lobby | active | finished
    seats: [],                // { name, type, token, difficulty }
    holdings: [],             // per seat: { ruby, amber, jade, azure }
    seals: [],                // per seat: { ruby: true, ... }
    shiftUsed: [],            // per seat: boolean
    quarries: QUARRIES.map((q) => ({ id: q.id, left: PER_QUARRY, total: PER_QUARRY })),
    turn: 0,
    turnStartedAt: null,
    turnDeadline: null,
    moves: [],
    startedAt: null,
    finishedAt: null,
    result: null,
    lastActivity: Date.now(),
    pendingBotAt: null,
  };
  room.turnSeconds = TURN_SECONDS;
  rooms.set(code, room);
  return room;
}

function seatIndexByToken(room, token) {
  if (!token) return -1;
  return room.seats.findIndex((seat) => seat && seat.token === token);
}

function addSeat(room, seat) {
  if (room.seats.length >= MAX_SEATS) return -1;
  const index = room.seats.length;
  room.seats.push(seat);
  room.holdings.push({ ruby: 0, amber: 0, jade: 0, azure: 0 });
  room.seals.push({});
  room.shiftUsed.push(false);
  return index;
}

function quarryOf(room, id) {
  return room.quarries.find((q) => q.id === id);
}

// -------------------------------------------------------------- legal moves

function legalMoves(room, seat) {
  if (room.phase !== 'active' || seat !== room.turn) return [];
  const moves = [];
  for (const q of room.quarries) {
    if (q.left <= 0) continue;
    const max = Math.min(TAKE_MAX, q.left);
    for (let count = TAKE_MIN; count <= max; count += 1) {
      moves.push({
        id: `take:${q.id}:${count}`,
        action: 'take',
        quarry: q.id,
        count,
        description: `Take ${count} ${count === 1 ? 'stone' : 'stones'} from the ${labelOf(q.id)} quarry.`,
      });
    }
  }
  if (!room.shiftUsed[seat]) {
    const live = room.quarries.filter((q) => q.left > 0).map((q) => q.id);
    for (let i = 0; i < live.length; i += 1) {
      for (let j = i + 1; j < live.length; j += 1) {
        moves.push({
          id: `shift:${live[i]}+${live[j]}`,
          action: 'shift',
          from: [{ quarry: live[i], count: 1 }, { quarry: live[j], count: 1 }],
          description: `Double Shift: take 1 stone from the ${labelOf(live[i])} quarry and 1 from the ${labelOf(live[j])} quarry. Usable once per match.`,
        });
      }
    }
  }
  return moves;
}

const labelOf = (id) => (QUARRIES.find((q) => q.id === id) || { label: id }).label;

function applyMove(room, seat, move, meta = {}) {
  const taken = [];
  if (move.action === 'take') {
    const q = quarryOf(room, move.quarry);
    const count = Math.min(Math.max(1, Number(move.count) || 1), TAKE_MAX, q.left);
    q.left -= count;
    room.holdings[seat][q.id] += count;
    taken.push({ quarry: q.id, count, emptied: q.left === 0 });
    if (q.left === 0) room.seals[seat][q.id] = true;
  } else {
    for (const part of move.from) {
      const q = quarryOf(room, part.quarry);
      q.left -= 1;
      room.holdings[seat][q.id] += 1;
      taken.push({ quarry: q.id, count: 1, emptied: q.left === 0 });
      if (q.left === 0) room.seals[seat][q.id] = true;
    }
    room.shiftUsed[seat] = true;
  }
  room.moves.push({
    n: room.moves.length + 1,
    seat,
    action: move.action,
    taken,
    at: new Date().toISOString(),
    auto: Boolean(meta.auto),
  });
  room.lastActivity = Date.now();
  advanceTurn(room);
}

function advanceTurn(room) {
  if (room.quarries.every((q) => q.left === 0)) {
    finishRoom(room);
    return;
  }
  let next = room.turn;
  for (let step = 1; step <= MAX_SEATS; step += 1) {
    const candidate = (room.turn + step) % room.seats.length;
    if (room.seats[candidate]) { next = candidate; break; }
  }
  room.turn = next;
  room.turnStartedAt = Date.now();
  room.turnDeadline = room.turnStartedAt + room.turnSeconds * 1000;
  room.pendingBotAt = null;
}

// ---------------------------------------------------------------- scoring

function scoreBoard(room) {
  const perQuarry = [];
  const totals = room.seats.map(() => 0);
  const sealsBySeat = room.seats.map(() => 0);
  for (const q of room.quarries) {
    const held = room.holdings.map((h) => h[q.id] || 0);
    const best = Math.max(0, ...held);
    const leaders = held.map((n, i) => (n === best && best > 0 ? i : -1)).filter((i) => i >= 0);
    let leader = null;
    let points = 0;
    if (leaders.length === 1) {
      const others = held.filter((_, i) => i !== leaders[0]);
      const runnerUp = others.length ? Math.max(...others) : 0;
      points = best - runnerUp;
      leader = leaders[0];
    }
    if (leader !== null) totals[leader] += points;
    perQuarry.push({
      quarry: q.id,
      label: labelOf(q.id),
      held,
      leader,
      points,
      contested: leaders.length > 1 && best > 0,
    });
  }
  room.seats.forEach((seat, i) => {
    const sealCount = Object.keys(room.seals[i] || {}).length;
    sealsBySeat[i] = sealCount;
    totals[i] += sealCount * SEAL_BONUS;
  });
  return { perQuarry, totals, sealsBySeat };
}

function finishRoom(room) {
  room.phase = 'finished';
  room.finishedAt = Date.now();
  const board = scoreBoard(room);
  const best = Math.max(0, ...board.totals);
  const winners = board.totals.map((t, i) => (t === best ? i : -1)).filter((i) => i >= 0);
  let winner = winners[0];
  let tieBreak = 'total points';
  if (winners.length > 1) {
    const stones = room.seats.map((_, i) => Object.values(room.holdings[i]).reduce((a, b) => a + b, 0));
    const most = Math.max(...winners.map((i) => stones[i]));
    const finalists = winners.filter((i) => stones[i] === most);
    if (finalists.length === 1) {
      winner = finalists[0];
      tieBreak = 'points tied, won on total stones collected';
    } else {
      winner = null;
      tieBreak = 'points and stones tied';
    }
  }
  room.result = {
    scores: board.totals,
    seals: board.sealsBySeat,
    stones: room.seats.map((_, i) => Object.values(room.holdings[i]).reduce((a, b) => a + b, 0)),
    winner,
    tieBreak,
    perQuarry: board.perQuarry,
    turns: room.moves.length,
    durationSeconds: room.startedAt ? Math.round((room.finishedAt - room.startedAt) / 1000) : 0,
    finishedAt: new Date(room.finishedAt).toISOString(),
  };
  persistRoom(room);
}

function persistRoom(room) {
  try {
    fs.mkdirSync(MATCH_DIR, { recursive: true });
    fs.writeFileSync(path.join(MATCH_DIR, `${room.code}.json`), JSON.stringify(publicRecord(room), null, 1));
  } catch (err) {
    console.error('[quarry] could not persist match', room.code, err.message);
  }
}

function publicRecord(room) {
  return {
    code: room.code,
    phase: room.phase,
    seats: room.seats.map((s, i) => ({ seat: i, name: s.name, type: s.type, difficulty: s.difficulty || null })),
    quarries: room.quarries,
    holdings: room.holdings,
    seals: room.seals,
    shiftUsed: room.shiftUsed,
    moves: room.moves,
    result: room.result,
    startedAt: room.startedAt ? new Date(room.startedAt).toISOString() : null,
    finishedAt: room.finishedAt ? new Date(room.finishedAt).toISOString() : null,
  };
}

function publicState(room, seat) {
  const board = scoreBoard(room);
  return {
    code: room.code,
    phase: room.phase,
    seats: room.seats.map((s, i) => ({ seat: i, name: s.name, type: s.type, difficulty: s.difficulty || null })),
    quarries: room.quarries.map((q) => ({ ...q, label: labelOf(q.id) })),
    holdings: room.holdings,
    seals: room.seals.map((s, i) => Object.keys(s)),
    shiftUsed: room.shiftUsed,
    turn: room.phase === 'active' ? {
      seat: room.turn,
      secondsLeft: room.turnDeadline ? Math.max(0, Math.round((room.turnDeadline - Date.now()) / 1000)) : 0,
      turnSeconds: room.turnSeconds,
    } : null,
    liveScores: board.totals,
    livePerQuarry: board.perQuarry,
    moves: room.moves,
    result: room.result,
    rules: { takeMin: TAKE_MIN, takeMax: TAKE_MAX, sealBonus: SEAL_BONUS, quarries: QUARRIES.length, stonesPerQuarry: PER_QUARRY, seats: MAX_SEATS, turnSeconds: room.turnSeconds },
    you: typeof seat === 'number' && seat >= 0 ? youBlock(room, seat) : null,
    serverTime: new Date().toISOString(),
  };
}

// --------------------------------------------------------------- bot brain

function evaluateFor(room, seat) {
  let value = 0;
  const seats = room.seats.length;
  for (const q of room.quarries) {
    const held = room.holdings.map((h) => h[q.id] || 0);
    const mine = held[seat] || 0;
    const rivals = held.filter((_, i) => i !== seat);
    const bestRival = rivals.length ? Math.max(...rivals) : 0;
    if (mine > 0 && mine > bestRival) value += (mine - bestRival) * 1.0;
    const taken = q.total - q.left;
    if (taken > 0 && q.left > 0) value += (mine / taken) * q.left * 0.55;
    if (room.seals[seat][q.id]) value += SEAL_BONUS * 0.8;
  }
  if (seats === 0) return value;
  return value;
}

function evaluateAll(room) {
  const out = [];
  for (let i = 0; i < room.seats.length; i += 1) out.push(evaluateFor(room, i));
  return out;
}

// Multi-player (max-n) search: every seat in the tree plays to maximise its own evaluation.
// Search copies only the mutable game state - the move log is irrelevant to the evaluation.
function lightCopy(room) {
  return {
    phase: room.phase,
    seats: room.seats,
    quarries: room.quarries.map((q) => ({ id: q.id, left: q.left, total: q.total })),
    holdings: room.holdings.map((h) => ({ ...h })),
    seals: room.seals.map((s) => ({ ...s })),
    shiftUsed: room.shiftUsed.slice(),
    turn: room.turn,
    moves: [],
  };
}

function maxn(room, depth) {
  if (room.phase !== 'active' || depth <= 0) return evaluateAll(room);
  const mover = room.turn;
  const moves = legalMoves(room, mover);
  if (!moves.length) return evaluateAll(room);
  let bestVector = null;
  let bestValue = -Infinity;
  for (const move of moves) {
    const next = lightCopy(room);
    applyMoveQuiet(next, mover, move);
    const vector = maxn(next, depth - 1);
    if (vector[mover] > bestValue) {
      bestValue = vector[mover];
      bestVector = vector;
    }
  }
  return bestVector || evaluateAll(room);
}

function applyMoveQuiet(room, seat, move) {
  if (move.action === 'take') {
    const q = quarryOf(room, move.quarry);
    const count = Math.min(move.count, q.left);
    q.left -= count;
    room.holdings[seat][q.id] += count;
    if (q.left === 0) room.seals[seat][q.id] = true;
  } else {
    for (const part of move.from) {
      const q = quarryOf(room, part.quarry);
      q.left -= 1;
      room.holdings[seat][q.id] += 1;
      if (q.left === 0) room.seals[seat][q.id] = true;
    }
    room.shiftUsed[seat] = true;
  }
  if (room.quarries.every((q) => q.left === 0)) {
    room.phase = 'finished';
    return;
  }
  let next = room.turn;
  for (let step = 1; step <= MAX_SEATS; step += 1) {
    const candidate = (room.turn + step) % room.seats.length;
    if (room.seats[candidate]) { next = candidate; break; }
  }
  room.turn = next;
}

const DIFFICULTY_DEPTH = { easy: 1, medium: 2, hard: 3, brutal: 4 };

function chooseBotMove(room, seat, difficulty = 'medium') {
  const moves = legalMoves(room, seat);
  if (!moves.length) return null;
  const depth = DIFFICULTY_DEPTH[difficulty] || 2;
  const scored = moves.map((move) => {
    const next = lightCopy(room);
    applyMoveQuiet(next, seat, move);
    const vector = maxn(next, depth - 1);
    return { move, value: vector[seat] };
  });
  scored.sort((a, b) => b.value - a.value);
  if (difficulty === 'easy') {
    const pool = scored.filter((s) => s.value >= scored[0].value - 1.4);
    return pool[crypto.randomInt(pool.length)].move;
  }
  if (difficulty === 'medium') {
    const pool = scored.filter((s) => s.value >= scored[0].value - 0.35);
    return pool[crypto.randomInt(pool.length)].move;
  }
  const pool = scored.filter((s) => s.value === scored[0].value);
  return pool[crypto.randomInt(pool.length)].move;
}

// ---------------------------------------------------------- turn scheduler

setInterval(() => {
  const now = Date.now();
  for (const room of rooms.values()) {
    if (room.phase !== 'active') continue;
    const seat = room.seats[room.turn];
    if (!seat) { room.phase = 'lobby'; continue; }
    const isBot = seat.type === 'bot';
    if (isBot) {
      if (room.pendingBotAt) continue;
      room.pendingBotAt = now;
      const delay = 700 + crypto.randomInt(1400);
      setTimeout(() => {
        const current = rooms.get(room.code);
        if (!current || current.phase !== 'active' || current.turn !== room.turn) return;
        current.pendingBotAt = null;
        const chosen = chooseBotMove(current, current.turn, seat.difficulty || 'medium');
        if (chosen) applyMove(current, current.turn, chosen, { auto: false });
      }, delay);
      continue;
    }
    if (room.turnDeadline && now > room.turnDeadline + 250) {
      const chosen = chooseBotMove(room, room.turn, 'medium');
      if (chosen) applyMove(room, room.turn, chosen, { auto: true });
    }
  }
  for (const [code, room] of rooms) {
    if (room.phase === 'finished' && now - room.lastActivity > ROOM_TTL_MS) rooms.delete(code);
    else if (now - room.lastActivity > ROOM_TTL_MS) rooms.delete(code);
  }
}, 400);

// ----------------------------------------------------------------- routing

function normaliseMove(room, seat, body) {
  const moves = legalMoves(room, seat);
  if (body.id) {
    const match = moves.find((m) => m.id === body.id);
    if (!match) return { error: 'ILLEGAL_MOVE', message: `"${body.id}" is not a legal move right now. Read legalMoves from the state endpoint.` };
    return { move: match };
  }
  const action = body.action;
  if (action === 'take') {
    const count = Number(body.count);
    const target = moves.find((m) => m.action === 'take' && m.quarry === body.quarry && m.count === count);
    if (!target) return { error: 'ILLEGAL_MOVE', message: 'take requires a non-empty quarry and a count between 1 and 2 that is available.' };
    return { move: target };
  }
  if (action === 'shift' || action === 'double-shift') {
    const pair = Array.isArray(body.from) ? body.from.map((p) => p.quarry).slice(0, 2).sort() : [];
    const target = moves.find((m) => m.action === 'shift' && m.from.map((p) => p.quarry).sort().join('+') === pair.join('+'));
    if (!target) return { error: 'ILLEGAL_MOVE', message: 'shift requires two different non-empty quarries and can be used only once per match.' };
    return { move: target };
  }
  return { error: 'ILLEGAL_MOVE', message: 'Unrecognised move. Send {"id":"take:ruby:2"} or {"action":"take","quarry":"ruby","count":2}.' };
}

function requireRoom(res, code) {
  const room = rooms.get(String(code || '').toUpperCase());
  if (!room) {
    // A finished match may have been evicted from memory - serve it from disk.
    const file = path.join(MATCH_DIR, `${String(code || '').toUpperCase()}.json`);
    if (fs.existsSync(file)) {
      const record = JSON.parse(fs.readFileSync(file, 'utf8'));
      return { archived: record };
    }
    fail(res, 404, 'ROOM_NOT_FOUND', `No room with code ${code}.`);
    return null;
  }
  return { room };
}

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
};

function serveFile(res, filePath) {
  fs.readFile(filePath, (err, data) => {
    if (err) return fail(res, 404, 'NOT_FOUND', 'Not found.');
    res.writeHead(200, {
      'Content-Type': CONTENT_TYPES[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
      'Content-Length': data.length,
      'Cache-Control': 'no-store',
    });
    res.end(data);
  });
}

async function handle(req, res, url) {
  const parts = url.pathname.split('/').filter(Boolean);

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    });
    return res.end();
  }

  if (url.pathname === '/' || url.pathname === '/index.html') {
    return serveFile(res, path.join(PUBLIC_DIR, 'index.html'));
  }
  if (parts[0] === 'r' && parts[1]) {
    return serveFile(res, path.join(PUBLIC_DIR, 'index.html'));
  }
  if (url.pathname === '/api-docs') {
    return serveFile(res, path.join(PUBLIC_DIR, 'api-docs.html'));
  }
  if (url.pathname === '/api/health') {
    return json(res, 200, { ok: true, phase: 'ok', rooms: rooms.size, rules: RULES_SUMMARY, uptimeSeconds: Math.round(process.uptime()) });
  }

  if (parts[0] !== 'api' || parts[1] !== 'rooms') {
    return fail(res, 404, 'NOT_FOUND', 'Not found. See /api-docs.');
  }

  // POST /api/rooms
  if (parts.length === 2) {
    if (req.method !== 'POST') return fail(res, 405, 'METHOD_NOT_ALLOWED', 'Use POST to create a room.');
    const body = await readBody(req);
    const room = newRoom();
    const seat = addSeat(room, { name: cleanName(body.name), type: 'human', token: randomToken() });
    if (body.difficulty && DIFFICULTY_DEPTH[body.difficulty]) room.defaultDifficulty = body.difficulty;
    const bots = Math.max(0, Math.min(MAX_SEATS - 1, Number(body.bots) || 0));
    for (let i = 0; i < bots; i += 1) {
      addSeat(room, { name: `Bot ${'ABCD'[i] || i}`, type: 'bot', difficulty: room.defaultDifficulty || 'medium' });
    }
    const autostart = body.autostart === true && room.seats.length >= 2;
    if (autostart) startRoom(room);
    return json(res, 201, {
      ok: true,
      code: room.code,
      seat,
      token: room.seats[seat].token,
      state: publicState(room, seat),
    });
  }

  const code = parts[2];
  const found = requireRoom(res, code);
  if (!found) return undefined;
  const room = found.room;
  if (!room) {
    return json(res, 200, { ok: true, archived: true, record: found.archived });
  }
  const action = parts[3];

  if (!action && req.method === 'GET') return json(res, 200, { ok: true, state: publicState(room) });

  if (action === 'join' && req.method === 'POST') {
    const body = await readBody(req);
    if (room.phase !== 'lobby') return fail(res, 409, 'ROOM_STARTED', 'This match has already started. Create a new room.');
    if (seatIndexByToken(room, body.token) >= 0) {
      const seat = seatIndexByToken(room, body.token);
      return json(res, 200, { ok: true, code: room.code, seat, token: body.token, state: publicState(room, seat) });
    }
    const index = addSeat(room, { name: cleanName(body.name), type: 'human', token: randomToken() });
    if (index < 0) return fail(res, 409, 'ROOM_FULL', 'This room already has four seats.');
    room.lastActivity = Date.now();
    return json(res, 200, { ok: true, code: room.code, seat: index, token: room.seats[index].token, state: publicState(room, index) });
  }

  if (action === 'bot' && req.method === 'POST') {
    const body = await readBody(req);
    if (room.phase !== 'lobby') return fail(res, 409, 'ROOM_STARTED', 'Bots can only take empty seats in the lobby.');
    const difficulty = DIFFICULTY_DEPTH[body.difficulty] ? body.difficulty : (room.defaultDifficulty || 'medium');
    const index = addSeat(room, { name: `Bot ${['A', 'B', 'C', 'D'][room.seats.length] || room.seats.length}`, type: 'bot', difficulty });
    if (index < 0) return fail(res, 409, 'ROOM_FULL', 'This room already has four seats.');
    return json(res, 200, { ok: true, seat: index, state: publicState(room) });
  }

  if (action === 'start' && req.method === 'POST') {
    const body = await readBody(req);
    if (room.phase !== 'lobby') return fail(res, 409, 'ROOM_STARTED', 'This match has already started.');
    const seat = seatIndexByToken(room, body.token);
    if (seat !== 0) return fail(res, 403, 'NOT_HOST', 'Only the player who created the room can start the match.');
    if (room.seats.length < 2) return fail(res, 409, 'NOT_ENOUGH_SEATS', 'At least two seats must be filled. Add a bot or share the room code.');
    startRoom(room);
    return json(res, 200, { ok: true, state: publicState(room, seat) });
  }

  if (action === 'move' && req.method === 'POST') {
    const body = await readBody(req);
    if (room.phase === 'lobby') return fail(res, 409, 'NOT_STARTED', 'This match has not started yet.');
    if (room.phase === 'finished') return fail(res, 409, 'MATCH_FINISHED', 'This match is over. See /log for the record.');
    const seat = seatIndexByToken(room, body.token);
    if (seat < 0) return fail(res, 403, 'BAD_TOKEN', 'Missing or unknown player token for this room.');
    if (seat !== room.turn) return fail(res, 409, 'NOT_YOUR_TURN', `It is seat ${room.turn}'s turn.`);
    const parsed = normaliseMove(room, seat, body);
    if (parsed.error) return fail(res, 400, parsed.error, parsed.message);
    applyMove(room, seat, parsed.move, { auto: false });
    return json(res, 200, { ok: true, played: parsed.move, state: publicState(room, seat) });
  }

  if (action === 'state' || (!action && req.method === 'GET')) {
    const token = url.searchParams.get('token');
    const seat = seatIndexByToken(room, token);
    return json(res, 200, { ok: true, state: publicState(room, seat) });
  }

  if (action === 'log') {
    return json(res, 200, { ok: true, record: publicRecord(room) });
  }

  return fail(res, 404, 'NOT_FOUND', 'Unknown endpoint. See /api-docs.');
}

const RULES_SUMMARY = `Four quarries (Ruby, Amber, Jade, Azure) start with 9 stones each. On your turn take one or two stones from a single quarry, or spend your once-per-match Double Shift to take 1 stone from each of two different quarries. When all quarries are empty the match ends. Scoring per quarry: a strict leader scores their stones minus the runner-up's; a tie for the lead scores nothing for anyone. Taking the last stone from a quarry earns a Seal worth +2 points. Highest total wins; ties break on total stones collected.`;

function youBlock(room, seat) {
  return {
    seat,
    name: room.seats[seat] ? room.seats[seat].name : null,
    isYourTurn: room.phase === 'active' && room.turn === seat,
    shiftAvailable: !room.shiftUsed[seat],
    holdings: room.holdings[seat] || null,
    legalMoves: legalMoves(room, seat),
  };
}

function cleanName(raw) {
  const name = String(raw == null ? '' : raw).replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 24);
  return name || `Player ${crypto.randomInt(10, 99)}`;
}

function startRoom(room) {
  room.phase = 'active';
  room.startedAt = Date.now();
  room.turn = 0;
  room.turnStartedAt = Date.now();
  room.turnDeadline = room.turnStartedAt + room.turnSeconds * 1000;
  room.lastActivity = Date.now();
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  handle(req, res, url).catch((err) => {
    if (res.headersSent) return;
    fail(res, err.statusCode || 500, 'SERVER_ERROR', err.message || 'Unexpected error.');
  });
});

fs.mkdirSync(MATCH_DIR, { recursive: true });

server.listen(PORT, HOST, () => {
  console.log(`[quarry] listening on http://${HOST}:${PORT} (turn timer ${TURN_SECONDS}s)`);
});

process.on('SIGTERM', () => {
  console.log('[quarry] shutting down');
  server.close(() => process.exit(0));
});
