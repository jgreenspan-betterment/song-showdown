// Song Showdown — zero-dependency game server.
// Run: node server.js   (PORT env var optional, defaults to 8888)
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const PORT = process.env.PORT || 8888;
const ROOT = __dirname;
const PUB = path.join(ROOT, 'public');
const STATE_FILE = path.join(ROOT, 'game-state.json');

// ---------- config ----------
function readConfig() {
  let clientId = process.env.SPOTIFY_CLIENT_ID || '';
  let clientSecret = process.env.SPOTIFY_CLIENT_SECRET || '';
  try {
    const c = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
    if (!clientId) clientId = c.clientId || '';
    if (!clientSecret) clientSecret = c.clientSecret || '';
  } catch (_) {}
  return { clientId, clientSecret };
}

// Shared app token (Client Credentials) — powers catalog search for everyone,
// no per-user Spotify login or dev-dashboard allowlisting needed.
let spTok = { value: null, exp: 0 };
async function serverToken() {
  const { clientId, clientSecret } = readConfig();
  if (!clientId || !clientSecret) throw { code: 503, msg: 'Search not configured — set clientId + clientSecret in config.json' };
  if (spTok.value && Date.now() < spTok.exp) return spTok.value;
  const res = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: 'Basic ' + Buffer.from(clientId + ':' + clientSecret).toString('base64'),
    },
    body: 'grant_type=client_credentials',
  });
  const d = await res.json().catch(() => ({}));
  if (!res.ok) throw { code: 502, msg: 'Spotify auth failed: ' + (d.error_description || d.error || res.status) };
  spTok = { value: d.access_token, exp: Date.now() + (d.expires_in - 60) * 1000 };
  return spTok.value;
}

// ---------- game state ----------
function newGame(players = []) {
  return {
    v: 1,
    phase: 'lobby', // lobby | picking | submitting | voting | results
    round: 0,
    players, // {id, name, isHost}
    pickerId: null,
    category: null,
    submissions: [], // {sid, playerId, track}  track = {id?,name,artists,album?,image?,url?} | {manual}
    votes: {}, // voterId -> sid
    order: [], // shuffled sids for anonymous display
    winner: null, // {sid, playerId} — never sent to clients directly
    history: [], // {round, category, track, votes}
    adminSpotifyId: null, // Spotify user id that owns admin (set on first verified claim)
  };
}

let game = null;
try { game = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch (_) {}
if (!game || !game.phase) game = newGame();

function save() {
  try { fs.writeFileSync(STATE_FILE, JSON.stringify(game)); } catch (_) {}
}
function bump() { game.v++; save(); }
function id() { return crypto.randomBytes(8).toString('hex'); }
function player(pid) { return game.players.find(p => p.id === pid); }
function host() { return game.players.find(p => p.isHost) || game.players[0]; }

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function cleanTrack(t) {
  if (!t || typeof t !== 'object') return null;
  const s = (v, n) => (typeof v === 'string' ? v.slice(0, n) : '');
  const num = (v, max) => (Number.isFinite(+v) && +v >= 0 ? Math.min(max, Math.round(+v)) : null);
  if (t.manual) return { manual: s(t.manual, 160) };
  if (!t.name) return null;
  return {
    id: s(t.id, 40) || null,
    name: s(t.name, 160),
    artists: s(t.artists, 160),
    album: s(t.album, 160) || null,
    image: /^https:\/\/i\.scdn\.co\//.test(t.image || '') ? t.image : null,
    url: /^https:\/\/open\.spotify\.com\//.test(t.url || '') ? t.url : null,
    durationMs: num(t.durationMs, 3600000),
    startSec: t.startSec == null ? null : num(t.startSec, 3600), // null = auto snippet
    fadeIn: t.fadeIn == null ? null : num(t.fadeIn, 8),   // seconds, final-mix fades
    fadeOut: t.fadeOut == null ? null : num(t.fadeOut, 8),
  };
}

// ---------- phase transitions ----------
function startVoting() {
  game.order = shuffle(game.submissions.map(s => s.sid));
  game.votes = {};
  game.phase = 'voting';
}

function finishRound() {
  const tally = {};
  for (const sid of Object.values(game.votes)) tally[sid] = (tally[sid] || 0) + 1;
  let best = -1, winners = [];
  for (const s of game.submissions) {
    const n = tally[s.sid] || 0;
    if (n > best) { best = n; winners = [s]; }
    else if (n === best) winners.push(s);
  }
  const w = winners[crypto.randomInt(winners.length)];
  game.winner = { sid: w.sid, playerId: w.playerId };
  game.tiedSids = winners.length > 1 ? winners.map(x => x.sid) : [];
  game.revealed = false;
  game.tally = tally;
  game.history.push({ round: game.round, category: game.category, track: w.track, votes: best, by: (player(w.playerId) || {}).name || '?', tie: winners.length > 1 });
  game.phase = 'results';
}

function startPicking(pickerId) {
  game.round++;
  game.pickerId = pickerId;
  game.category = null;
  game.submissions = [];
  game.votes = {};
  game.order = [];
  game.winner = null;
  game.tally = {};
  game.tiedSids = [];
  game.revealed = true;
  game.phase = 'picking';
}

// ---------- state view (anonymity enforced here) ----------
function publicState(pid) {
  const me = player(pid);
  const h = host();
  const st = {
    v: game.v,
    phase: game.phase,
    round: game.round,
    category: game.category,
    you: me ? { name: me.name, isHost: !!me.isHost } : null,
    players: game.players.map(p => ({
      name: p.name,
      isHost: !!p.isHost,
      submitted: game.phase === 'submitting' ? game.submissions.some(s => s.playerId === p.id) : undefined,
      voted: game.phase === 'voting' ? !!game.votes[p.id] : undefined,
    })),
    history: game.history,
  };
  if (game.phase === 'picking') {
    st.youArePicker = !!me && game.pickerId === me.id;
    st.pickerLabel = (player(game.pickerId) || h || {}).name || 'someone';
  }
  if (game.phase === 'submitting') {
    st.submittedCount = game.submissions.length;
    const mine = game.submissions.find(s => s.playerId === pid);
    st.yourSubmission = mine ? mine.track : null;
  }
  if (game.phase === 'voting' || game.phase === 'results') {
    st.songs = game.order.map(sid => {
      const s = game.submissions.find(x => x.sid === sid);
      const item = { sid, track: s.track, mine: s.playerId === pid };
      if (game.phase === 'results') {
        item.votes = (game.tally && game.tally[sid]) || 0;
        item.winner = game.winner && game.winner.sid === sid;
        item.by = game.revealed ? ((player(s.playerId) || {}).name || 'left the game') : null;
        item.tied = (game.tiedSids || []).includes(sid);
      }
      return item;
    });
  }
  if (game.phase === 'voting') {
    st.votedCount = Object.keys(game.votes).length;
    st.yourVote = game.votes[pid] || null;
  }
  if (game.phase === 'results') {
    st.youWon = !!(game.winner && game.winner.playerId === pid);
    st.revealed = !!game.revealed;
    st.winnerName = game.revealed && game.winner ? ((player(game.winner.playerId) || {}).name || '?') : null;
    st.tieCount = (game.tiedSids || []).length;
    if (!game.revealed) st.history = game.history.map((h, i) => (i === game.history.length - 1 ? { ...h, by: null } : h));
  }
  return st;
}

// ---------- API handlers ----------
const api = {
  'GET /api/config': () => {
    const c = readConfig();
    return { clientId: c.clientId, serverSearch: !!(c.clientId && c.clientSecret) };
  },
  'GET /api/state': (q) => publicState(q.playerId),

  'GET /api/search': async (q) => {
    const query = (q.q || '').trim().slice(0, 120);
    if (!query) return { tracks: [] };
    const tok = await serverToken();
    const res = await fetch('https://api.spotify.com/v1/search?type=track&limit=10&q=' + encodeURIComponent(query), {
      headers: { Authorization: 'Bearer ' + tok },
    });
    if (res.status === 401) { spTok = { value: null, exp: 0 }; throw { code: 502, msg: 'Spotify session expired — search again' }; }
    if (!res.ok) throw { code: 502, msg: 'Spotify search error ' + res.status };
    const d = await res.json();
    return {
      tracks: (d.tracks?.items || []).map((t) => ({
        id: t.id, name: t.name,
        artists: (t.artists || []).map((a) => a.name).join(', '),
        album: t.album?.name || null,
        image: t.album?.images?.length ? t.album.images[t.album.images.length - 1].url : null,
        url: t.external_urls?.spotify || null,
        durationMs: t.duration_ms || null,
      })),
    };
  },

  'POST /api/join': (q, body) => {
    const name = (body.name || '').trim().slice(0, 24);
    if (!name) throw { code: 400, msg: 'Name required' };
    // Reconnect by id if the client already has one.
    if (body.playerId && player(body.playerId)) return { playerId: body.playerId };
    const p = { id: id(), name, isHost: game.players.length === 0 };
    game.players.push(p);
    bump();
    return { playerId: p.id };
  },

  'POST /api/start': (q, body) => {
    const me = player(body.playerId);
    if (!me || !me.isHost) throw { code: 403, msg: 'Only the host can start' };
    if (game.phase !== 'lobby') throw { code: 409, msg: 'Already started' };
    startPicking(me.id);
    bump();
    return { ok: true };
  },

  'POST /api/category': (q, body) => {
    const me = player(body.playerId);
    if (!me || game.phase !== 'picking' || (game.pickerId !== me.id && !me.isHost)) throw { code: 403, msg: 'Not your pick' };
    const cat = (body.category || '').trim().slice(0, 80);
    if (!cat) throw { code: 400, msg: 'Category required' };
    game.category = cat;
    game.phase = 'submitting';
    bump();
    return { ok: true };
  },

  'POST /api/submit': (q, body) => {
    const me = player(body.playerId);
    if (!me || game.phase !== 'submitting') throw { code: 409, msg: 'Not accepting submissions' };
    const track = cleanTrack(body.track);
    if (!track) throw { code: 400, msg: 'Invalid song' };
    const existing = game.submissions.find(s => s.playerId === me.id);
    if (existing) existing.track = track; // can change your pick until voting starts
    else game.submissions.push({ sid: id(), playerId: me.id, track });
    if (game.submissions.length >= game.players.length) startVoting();
    bump();
    return { ok: true };
  },

  'POST /api/vote': (q, body) => {
    const me = player(body.playerId);
    if (!me || game.phase !== 'voting') throw { code: 409, msg: 'Not in voting' };
    const s = game.submissions.find(x => x.sid === body.sid);
    if (!s) throw { code: 400, msg: 'Unknown song' };
    // Solo game (testing): self-vote allowed, otherwise the round can never end.
    if (s.playerId === me.id && game.players.length > 1) throw { code: 400, msg: "Can't vote for your own song" };
    game.votes[me.id] = s.sid;
    if (Object.keys(game.votes).length >= game.players.length) finishRound();
    bump();
    return { ok: true };
  },

  'POST /api/next': (q, body) => {
    const me = player(body.playerId);
    if (!me || !['results', 'finale'].includes(game.phase)) throw { code: 409, msg: 'Not in results' };
    const isWinner = game.winner && game.winner.playerId === me.id;
    if (!me.isHost && !isWinner) throw { code: 403, msg: 'Waiting for the winner (or host)' };
    game.revealed = true;
    // The round winner picks the next category themselves; host is the fallback picker.
    startPicking(game.winner && player(game.winner.playerId) ? game.winner.playerId : (host() || me).id);
    bump();
    return { ok: true };
  },

  'POST /api/snippet': (q, body) => {
    const me = player(body.playerId);
    if (!me || !['submitting', 'voting'].includes(game.phase)) throw { code: 409, msg: 'Snippet locked for this round' };
    const mine = game.submissions.find(s => s.playerId === me.id);
    if (!mine || !mine.track.id) throw { code: 400, msg: 'No editable submission' };
    const num = (v, max) => (Number.isFinite(+v) && +v >= 0 ? Math.min(max, Math.round(+v)) : null);
    mine.track.startSec = body.startSec == null ? null : num(body.startSec, 3600);
    if (body.fadeIn != null) mine.track.fadeIn = num(body.fadeIn, 8);
    if (body.fadeOut != null) mine.track.fadeOut = num(body.fadeOut, 8);
    bump();
    return { ok: true };
  },

  'POST /api/admin': async (q, body) => {
    const me = player(body.playerId);
    if (!me) throw { code: 400, msg: 'Join the game first' };
    const tok = typeof body.token === 'string' ? body.token.slice(0, 500) : '';
    if (!tok) throw { code: 400, msg: 'No Spotify session' };
    const res = await fetch('https://api.spotify.com/v1/me', { headers: { Authorization: 'Bearer ' + tok } });
    if (!res.ok) throw { code: 403, msg: 'Spotify verification failed' };
    const d = await res.json();
    if (game.adminSpotifyId && game.adminSpotifyId !== d.id) throw { code: 403, msg: 'Admin belongs to another Spotify account' };
    game.adminSpotifyId = d.id;
    game.players.forEach(p => { p.isHost = p.id === me.id; });
    bump();
    return { ok: true, account: d.display_name || d.id };
  },

  'POST /api/kick': (q, body) => {
    const me = player(body.playerId);
    if (!me || !me.isHost) throw { code: 403, msg: 'Host only' };
    const t = player(body.targetId);
    if (!t) return { ok: true };
    if (t.isHost) throw { code: 400, msg: "Can't remove the host" };
    game.players = game.players.filter(p => p.id !== t.id);
    const sub = game.submissions.find(s => s.playerId === t.id);
    if (sub) {
      game.submissions = game.submissions.filter(s => s.sid !== sub.sid);
      game.order = game.order.filter(sid => sid !== sub.sid);
      for (const k of Object.keys(game.votes)) if (game.votes[k] === sub.sid) delete game.votes[k];
    }
    delete game.votes[t.id];
    if (game.pickerId === t.id) game.pickerId = (host() || {}).id || null;
    bump();
    return { ok: true };
  },

  'POST /api/reveal': (q, body) => {
    const me = player(body.playerId);
    if (!me || !me.isHost) throw { code: 403, msg: 'Host only' };
    if (game.phase !== 'results') throw { code: 409, msg: 'Nothing to reveal' };
    game.revealed = true;
    bump();
    return { ok: true };
  },

  'POST /api/goto': (q, body) => {
    const me = player(body.playerId);
    if (!me || !me.isHost) throw { code: 403, msg: 'Host only' };
    const ph = body.phase;
    if (ph === 'lobby') game.phase = 'lobby';
    else if (ph === 'picking') {
      if (!game.round) startPicking(me.id);
      else {
        game.category = null; game.submissions = []; game.votes = {}; game.order = [];
        game.winner = null; game.tally = {}; game.pickerId = (host() || me).id;
        game.phase = 'picking';
      }
    } else if (ph === 'submitting') {
      if (!game.category) throw { code: 400, msg: 'Pick a category first' };
      game.votes = {}; game.order = []; game.winner = null; game.tally = {};
      game.phase = 'submitting';
    } else if (ph === 'voting') {
      if (!game.submissions.length) throw { code: 400, msg: 'No submissions yet' };
      startVoting();
    } else if (ph === 'finale') {
      if (!game.history.length) throw { code: 400, msg: 'Finish at least one round first' };
      game.revealed = true;
      game.phase = 'finale';
    } else throw { code: 400, msg: 'Unknown stage' };
    bump();
    return { ok: true };
  },

  'POST /api/finale': (q, body) => {
    const me = player(body.playerId);
    if (!me || !me.isHost) throw { code: 403, msg: 'Host only' };
    if (!game.history.length) throw { code: 400, msg: 'Finish at least one round first' };
    game.revealed = true;
    game.phase = 'finale';
    bump();
    return { ok: true };
  },

  'POST /api/force': (q, body) => {
    const me = player(body.playerId);
    if (!me || !me.isHost) throw { code: 403, msg: 'Host only' };
    if (game.phase === 'submitting' && game.submissions.length >= 2) startVoting();
    else if (game.phase === 'voting') finishRound();
    else throw { code: 409, msg: 'Nothing to force here' };
    bump();
    return { ok: true };
  },

  'POST /api/reset': (q, body) => {
    const me = player(body.playerId);
    if (!me || !me.isHost) throw { code: 403, msg: 'Host only' };
    const admin = game.adminSpotifyId;
    game = newGame(game.players);
    game.adminSpotifyId = admin;
    bump();
    return { ok: true };
  },
};

// ---------- HTTP plumbing ----------
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };

const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  const q = Object.fromEntries(u.searchParams);
  const key = `${req.method} ${u.pathname}`;

  if (api[key]) {
    let raw = '';
    req.on('data', c => { raw += c; if (raw.length > 1e5) req.destroy(); });
    req.on('end', async () => {
      let body = {};
      try { body = raw ? JSON.parse(raw) : {}; } catch (_) {}
      try {
        const out = await api[key](q, body);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(out));
      } catch (e) {
        res.writeHead(e.code || 500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.msg || 'Server error' }));
      }
    });
    return;
  }

  // Static files; SPA routes (/, /callback) get index.html.
  let file = u.pathname === '/' || u.pathname === '/callback' ? '/index.html' : u.pathname;
  file = path.normalize(file).replace(/^(\.\.[/\\])+/, '');
  const fp = path.join(PUB, file);
  if (!fp.startsWith(PUB)) { res.writeHead(403); res.end(); return; }
  fs.readFile(fp, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    // no-store: browsers must always fetch current game code (heuristic caching served stale JS)
    res.writeHead(200, { 'Content-Type': MIME[path.extname(fp)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(data);
  });
});

server.listen(PORT, () => {
  const c = readConfig();
  console.log(`Song Showdown running at http://127.0.0.1:${PORT}`);
  if (!c.clientId || !c.clientSecret) console.log('NOTE: set clientId + clientSecret in config.json to enable song search for everyone. Manual song entry works regardless.');
});
