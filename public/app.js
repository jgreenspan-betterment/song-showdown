/* Song Showdown client */

// ---------------- helpers ----------------
const $ = (sel) => document.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function toast(msg, isErr = true) {
  const t = $('#toast');
  t.textContent = msg;
  t.className = isErr ? 'err' : 'ok';
  clearTimeout(toast._t);
  toast._t = setTimeout(() => (t.className = 'hidden'), 3500);
}

async function api(path, body) {
  const opts = body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {};
  const res = await fetch(path, opts);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

// ---------------- categories ----------------
const PROMPTS = [
  'Instrumentals', 'Songs with no vocals', 'Covers', 'Songs under 2 minutes',
  'Guilty pleasures', 'Pump me up', 'Earworms', 'Movie soundtrack',
  'One-word title', 'Songs to cry to', 'Road trip', 'Karaoke banger',
  'Best opening 10 seconds', 'Song you loved in high school', 'Best song from a bad artist',
  'Hidden gem (under 1M plays)', 'Best duet or collab', 'Song in another language',
];
const GENRES = [
  '80s', '90s', '2000s', 'Hip-hop', 'Country', 'Jazz', 'Punk', 'Disco', 'R&B',
  'Indie', 'Metal', 'Pop-punk', 'K-pop', 'Classical', 'Folk', 'Electronic', 'Reggae', 'Latin',
];
const DJFLOW = [
  'Warm-up opener', 'Build the energy', 'Peak-hour banger', 'The drop',
  'Smooth groove', 'Sunset set', 'Cooldown', 'After-hours (2am)',
  'Set closer', 'Mixes well after last winner',
];

// ---------------- identity ----------------
const store = {
  get playerId() { return localStorage.getItem('ssg_player_id'); },
  set playerId(v) { v ? localStorage.setItem('ssg_player_id', v) : localStorage.removeItem('ssg_player_id'); },
  get name() { return localStorage.getItem('ssg_name') || ''; },
  set name(v) { localStorage.setItem('ssg_name', v); },
  get impersonate() { try { return JSON.parse(localStorage.getItem('ssg_impersonate')); } catch (_) { return null; } },
  set impersonate(v) { v ? localStorage.setItem('ssg_impersonate', JSON.stringify(v)) : localStorage.removeItem('ssg_impersonate'); },
};
// The identity game actions run as: the impersonated test player, else yourself.
// Admin actions always use store.playerId directly.
const pid = () => (store.impersonate ? store.impersonate.id : store.playerId);
function setImpersonate(v) {
  store.impersonate = v;
  state = null; renderedKey = '';
  poll();
}

// ---------------- Spotify auth (Authorization Code + PKCE) ----------------
// streaming + read-email/private + playback-state power the Final Mix DJ player (Web Playback SDK)
const SCOPES = 'user-library-read user-top-read streaming user-read-email user-read-private user-read-playback-state user-modify-playback-state playlist-modify-public';
let clientId = '';
let serverSearch = false; // server-side catalog search (no user login needed)

const spotify = {
  get token() { return localStorage.getItem('sp_access_token'); },
  get connected() { return !!this.token; },

  async login() {
    if (!clientId) return toast('Spotify isn’t configured yet — ask the host to set the client ID. You can still type songs in manually.');
    const verifier = [...crypto.getRandomValues(new Uint8Array(48))].map((b) => 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'[b % 62]).join('');
    localStorage.setItem('sp_verifier', verifier);
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
    const challenge = btoa(String.fromCharCode(...new Uint8Array(digest))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    const u = new URL('https://accounts.spotify.com/authorize');
    u.search = new URLSearchParams({
      client_id: clientId, response_type: 'code', redirect_uri: location.origin + '/callback',
      scope: SCOPES, code_challenge_method: 'S256', code_challenge: challenge,
    });
    location.href = u;
  },

  async handleCallback() {
    const code = new URLSearchParams(location.search).get('code');
    if (location.pathname !== '/callback' || !code) return;
    try {
      await this._tokenRequest({
        grant_type: 'authorization_code', code, redirect_uri: location.origin + '/callback',
        client_id: clientId, code_verifier: localStorage.getItem('sp_verifier') || '',
      });
      toast('Spotify connected ✓', false);
    } catch (e) {
      toast('Spotify login failed: ' + e.message);
    }
    history.replaceState(null, '', '/');
  },

  async _tokenRequest(params) {
    const res = await fetch('https://accounts.spotify.com/api/token', {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(params),
    });
    const d = await res.json();
    if (!res.ok) throw new Error(d.error_description || d.error || 'token error');
    localStorage.setItem('sp_access_token', d.access_token);
    if (d.refresh_token) localStorage.setItem('sp_refresh_token', d.refresh_token);
    localStorage.setItem('sp_expires_at', Date.now() + (d.expires_in - 60) * 1000);
  },

  async refresh() {
    const rt = localStorage.getItem('sp_refresh_token');
    if (!rt) return false;
    try {
      await this._tokenRequest({ grant_type: 'refresh_token', refresh_token: rt, client_id: clientId });
      return true;
    } catch (_) { this.disconnect(); return false; }
  },

  disconnect() {
    ['sp_access_token', 'sp_refresh_token', 'sp_expires_at', 'sp_verifier'].forEach((k) => localStorage.removeItem(k));
    renderSpotifyBtn();
  },

  async call(path) {
    if (Date.now() > +(localStorage.getItem('sp_expires_at') || 0)) await this.refresh();
    const res = await fetch('https://api.spotify.com/v1' + path, { headers: { Authorization: 'Bearer ' + this.token } });
    if (res.status === 401 && (await this.refresh())) {
      return fetch('https://api.spotify.com/v1' + path, { headers: { Authorization: 'Bearer ' + this.token } }).then((r) => r.json());
    }
    if (!res.ok) throw new Error('Spotify API error ' + res.status);
    return res.json();
  },

  async post(path, body) {
    if (Date.now() > +(localStorage.getItem('sp_expires_at') || 0)) await this.refresh();
    const res = await fetch('https://api.spotify.com/v1' + path, {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + this.token, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error('Spotify API error ' + res.status);
    return res.json();
  },

  trackToPayload(t) {
    return {
      id: t.id, name: t.name,
      artists: (t.artists || []).map((a) => a.name).join(', '),
      album: t.album?.name || null,
      image: t.album?.images?.at(-1)?.url || null, // smallest image
      url: t.external_urls?.spotify || null,
      durationMs: t.duration_ms || null,
    };
  },
};

function renderSpotifyBtn() {
  const b = $('#spotify-btn');
  b.classList.remove('hidden');
  if (spotify.connected) { b.textContent = 'Spotify ✓'; b.onclick = () => { if (confirm('Disconnect Spotify?')) spotify.disconnect(); }; }
  else { b.textContent = 'Connect Spotify'; b.onclick = () => spotify.login(); }
}

// ---------------- polling + render dispatch ----------------
let state = null;
let renderedKey = '';
let staged = null; // song chosen but not yet submitted (submit screen)

async function poll() {
  let s;
  try {
    s = await api('/api/state?playerId=' + encodeURIComponent(pid() || ''));
    // Impersonated test player vanished (kicked / server wiped) — snap back to yourself.
    if (store.impersonate && !s.you) {
      store.impersonate = null;
      toast('Test player is gone — back to yourself', false);
      state = null; renderedKey = '';
      return;
    }
    if (s.you) localStorage.setItem('ssg_wipe', String(s.wipe || 0));
    // Host wiped the lobby: drop our identity and show the join screen.
    if (store.playerId && !s.you && (s.wipe || 0) > +(localStorage.getItem('ssg_wipe') || 0)) {
      store.playerId = null;
      localStorage.setItem('ssg_wipe', String(s.wipe || 0));
      toast('The host reset the player list — join again to play', false);
      state = null; renderedKey = '';
      return;
    }
    // Server restarted / lost our player: rejoin with the saved name.
    if (store.playerId && !s.you && store.name) {
      const j = await api('/api/join', { name: store.name, playerId: store.playerId });
      store.playerId = j.playerId;
      return;
    }
    // Spotify-verified admin claim: only the app owner's account can pass this.
    if (s.you && !s.you.isHost && !store.impersonate && spotify.connected && !poll._claimed) {
      poll._claimed = true;
      api('/api/admin', { playerId: store.playerId, token: spotify.token })
        .then(() => { toast('Admin unlocked ✓', false); return poll(); })
        .catch(() => {});
    }
  } catch (_) { return; /* transient network error — keep polling */ }
  if (!state || s.v !== state.v) { state = s; render(); }
}

function render() {
  const s = state;
  $('#round-chip').classList.toggle('hidden', !s.round);
  $('#round-chip').textContent = s.round ? `Round ${s.round}` : '';

  const joined = !!s.you;
  const isHost = joined && s.you.isHost;
  $('#players-panel').classList.toggle('hidden', !joined || s.players.length === 0);
  $('#history-panel').classList.toggle('hidden', s.history.length === 0);
  renderPlayers(s);
  renderHistory(s);
  renderStepper(s);
  renderAdminPanel(s);

  // Lobby re-renders on joins (no inputs to preserve there); other phases only on phase/round change.
  const key = !joined ? 'join'
    : s.phase === 'lobby' ? `lobby:${s.players.length}`
    : s.phase === 'results' ? `results:${s.round}:${s.revealed ? 1 : 0}`
    : s.phase === 'finale' ? `finale:${s.round}:${s.playlistUrl ? 1 : 0}`
    : `${s.phase}:${s.round}`;
  if (key !== renderedKey) {
    renderedKey = key;
    const fn = { join: renderJoin, lobby: renderLobby, picking: renderPicking, submitting: renderSubmitting, voting: renderVoting, results: renderResults, finale: renderFinale };
    fn[joined ? s.phase : 'join'](s);
  } else {
    // Same screen, new data — targeted updates only (don't blow away inputs/iframes).
    updateInPlace(s);
  }
}

// ---------------- stage stepper (host: clickable, players: progress) ----------------
function renderStepper(s) {
  const el = $('#stepper');
  if (!el) return;
  if (!s.you) { el.innerHTML = ''; return; }
  const isHost = s.you.isHost;
  const stages = [
    { key: 'lobby', label: 'Lobby' },
    { key: 'picking', label: isHost ? 'Pick' : 'Category' },
    { key: 'submitting', label: 'Submit' },
    { key: 'voting', label: 'Vote' },
    { key: 'results', label: 'Results' },
    { key: 'finale', label: '🎬 Mix' },
  ];
  const clickable = (k) => isHost && k !== 'results' && k !== s.phase && !(k === 'finale' && !s.history.length);
  el.innerHTML = stages.map((st) =>
    `<button class="step ${s.phase === st.key ? 'cur' : ''}" data-k="${st.key}" ${clickable(st.key) ? '' : 'disabled'}>${st.label}</button>`
  ).join('<span class="step-sep">›</span>');
  el.querySelectorAll('.step:not([disabled])').forEach((b) => {
    b.onclick = () => {
      const k = b.dataset.k;
      const warn = {
        lobby: 'Back to the lobby?',
        picking: 'Re-pick the category? This round’s submissions are cleared.',
        voting: 'Jump to voting? Votes reset.',
        finale: 'End the game and go to the Final Mix?',
      }[k];
      if (warn && !confirm(warn)) return;
      api('/api/goto', { playerId: store.playerId, phase: k }).then(poll).catch((e) => toast(e.message));
    };
  });
}

// ---------------- admin side panel (host + Spotify-verified only) ----------------
function renderAdminPanel(s) {
  const panel = $('#admin-panel');
  const imp = store.impersonate;
  const show = !!(spotify.connected && (imp || (s.you && s.you.isHost)));
  panel.classList.toggle('hidden', !show);
  if (!show) return;
  // Don't rebuild controls mid-playback — playSet holds live references to its buttons.
  if (mix.running) return;

  let html = `
    <div id="ap-identity" class="${imp ? 'imp' : ''}">
      ${imp ? `🎭 Impersonating: <b>${esc(imp.name)}</b>` : `Acting as: <b>you</b>${s.you ? ` (${esc(s.you.name)})` : ''}`}
    </div>
    ${imp ? '<button id="tt-back" class="btn small primary">← Back to yourself</button>' : ''}`;
  if (['submitting', 'voting'].includes(s.phase)) html += '<button id="force-btn" class="btn small ghost">⏭ Force next phase</button>';
  if (s.history.length && s.phase !== 'finale') html += '<button id="finale-btn" class="btn small ghost">🎬 End game — Final Mix</button>';
  if (s.phase === 'finale') html += '<button id="admin-next" class="btn small ghost">▶ Keep playing — next round</button>';
  if (s.phase !== 'lobby') html += '<button id="reset-btn" class="btn small danger">Reset game</button>';
  html += '<button id="clear-players-btn" class="btn small danger">👥 Remove all players</button>';
  $('#ap-actions').innerHTML = html || '<p class="muted">Lobby — start the game from the main card, or add test players below.</p>';

  const bk = $('#tt-back');
  if (bk) bk.onclick = () => { setImpersonate(null); toast('Back to yourself ✓', false); };
  const f = $('#force-btn');
  if (f) f.onclick = () => confirm('Skip stragglers and move to the next phase?') && api('/api/force', { playerId: store.playerId }).then(poll).catch((e) => toast(e.message));
  const cp = $('#clear-players-btn');
  if (cp) cp.onclick = () => confirm('Remove ALL players except you? (open tabs will auto-rejoin)') &&
    api('/api/clear-players', { playerId: store.playerId }).then(() => { testStore.ids = []; return poll(); }).catch((e) => toast(e.message));
  const r = $('#reset-btn');
  if (r) r.onclick = () => confirm('Reset the whole game? (players stay)') && api('/api/reset', { playerId: store.playerId }).then(() => { renderedKey = ''; return poll(); }).catch((e) => toast(e.message));
  const an = $('#admin-next');
  if (an) an.onclick = () => api('/api/next', { playerId: store.playerId }).then(poll).catch((e) => toast(e.message));
  const fb = $('#finale-btn');
  if (fb) fb.onclick = () => api('/api/finale', { playerId: store.playerId }).then(poll).catch((e) => toast(e.message));
  renderTestTools(s);
}

// ---------------- test players (host-only, for solo testing) ----------------
const testStore = {
  get ids() { try { return JSON.parse(localStorage.getItem('ssg_test_ids')) || []; } catch (_) { return []; } },
  set ids(v) { localStorage.setItem('ssg_test_ids', JSON.stringify(v)); },
};
const shuffleArr = (a) => a.slice().sort(() => Math.random() - 0.5);

function renderTestTools(s) {
  const el = $('#test-tools');
  if (!el) return;
  if (!s.you || !s.you.isHost) { el.innerHTML = ''; return; }
  const bots = testStore.ids;
  const imp = store.impersonate;
  el.innerHTML = `
    <button id="tt-add" class="btn small ghost">➕ Add test player</button>
    ${bots.map((b) => `
      <div class="tt-row">
        <span>${imp && imp.id === b.id ? '🎭 ' : ''}${esc(b.name)}</span>
        <button class="btn small ${imp && imp.id === b.id ? 'primary' : 'ghost'} tt-imp" data-id="${esc(b.id)}" data-name="${esc(b.name)}">
          ${imp && imp.id === b.id ? 'Playing ✓' : 'Play as'}
        </button>
      </div>`).join('')}
    ${bots.length && s.phase === 'submitting' ? '<button id="tt-submit" class="btn small ghost">🎲 Submit for all tests</button>' : ''}
    ${bots.length && s.phase === 'voting' ? '<button id="tt-vote" class="btn small ghost">🎲 Vote as all tests</button>' : ''}
    ${bots.length ? '<button id="tt-clear" class="btn small ghost">🧹 Remove tests</button>' : ''}`;

  el.querySelectorAll('.tt-imp').forEach((b) => {
    b.onclick = () => {
      const already = store.impersonate && store.impersonate.id === b.dataset.id;
      setImpersonate(already ? null : { id: b.dataset.id, name: b.dataset.name });
      toast(already ? 'Back to yourself ✓' : `Now playing as ${b.dataset.name} 🎭`, false);
    };
  });

  $('#tt-add').onclick = async () => {
    try {
      const n = bots.length + 1;
      const j = await api('/api/join', { name: 'Test ' + n });
      testStore.ids = [...bots, { id: j.playerId, name: 'Test ' + n }];
      toast(`Test ${n} joined 🎭`, false);
      await poll();
    } catch (e) { toast(e.message); }
  };

  const sub = $('#tt-submit');
  if (sub) sub.onclick = async () => {
    const TERMS = ['daft punk', 'queen', 'abba', 'hans zimmer', 'beatles', 'fleetwood mac', 'outkast', 'toto', 'daft punk instrumental', 'movie soundtrack'];
    for (const b of testStore.ids) {
      try {
        let track = null;
        if (serverSearch) {
          const r = await api('/api/search?q=' + encodeURIComponent(TERMS[Math.floor(Math.random() * TERMS.length)]));
          track = r.tracks[Math.floor(Math.random() * Math.min(5, r.tracks.length))] || null;
        }
        await api('/api/submit', { playerId: b.id, track: track || { manual: 'Mystery track from ' + b.name } });
      } catch (_) { /* bot may be stale after a server wipe — ignore */ }
    }
    await poll();
  };

  const vt = $('#tt-vote');
  if (vt) vt.onclick = async () => {
    for (const b of testStore.ids) {
      for (const sid of shuffleArr((state.songs || []).map((x) => x.sid))) {
        try { await api('/api/vote', { playerId: b.id, sid }); break; } catch (_) { /* own song — try next */ }
      }
    }
    await poll();
  };

  const cl = $('#tt-clear');
  if (cl) cl.onclick = async () => {
    for (const b of testStore.ids) {
      try { await api('/api/kick', { playerId: store.playerId, targetId: b.id }); } catch (_) {}
    }
    if (store.impersonate) store.impersonate = null;
    testStore.ids = [];
    state = null; renderedKey = '';
    toast('Test players removed 🧹', false);
    await poll();
  };
}

function renderPlayers(s) {
  $('#player-list').innerHTML = s.players.map((p) => {
    let flag = '';
    if (p.submitted === true || p.voted === true) flag = ' ✓';
    else if (p.submitted === false || p.voted === false) flag = ' …';
    return `<li>${esc(p.name)}${p.isHost ? ' <span class="chip tiny">host</span>' : ''}<span class="ok-mark">${flag}</span></li>`;
  }).join('');
}

function renderHistory(s) {
  $('#history-list').innerHTML = s.history.map((h) => {
    const t = h.track.manual ? esc(h.track.manual) : `${esc(h.track.name)} — ${esc(h.track.artists)}`;
    return `<li><span class="muted">R${h.round} · ${esc(h.category)}:</span> 🏆 ${t}${h.by ? ` <span class="muted">(${esc(h.by)})</span>` : ''} (${h.votes} vote${h.votes === 1 ? '' : 's'}${h.tie ? ' · 🎲 tie-break' : ''})</li>`;
  }).join('');
}

// ---------------- screens ----------------
const root = () => $('#phase-root');

function renderJoin() {
  root().innerHTML = `
    <div class="card center-col">
      <h2>Join the game</h2>
      <p class="muted">One song per round. Anonymous votes. Winner picks the next category.</p>
      <input id="name-input" autocomplete="off" data-1p-ignore data-lpignore="true" maxlength="24" placeholder="Your name" value="${esc(store.name)}">
      <button id="join-btn" class="btn primary">Join</button>
    </div>`;
  const go = async () => {
    const name = $('#name-input').value.trim();
    if (!name) return toast('Enter a name first');
    try {
      const j = await api('/api/join', { name, playerId: store.playerId });
      store.name = name; store.playerId = j.playerId;
      state = null; await poll();
    } catch (e) { toast(e.message); }
  };
  $('#join-btn').onclick = go;
  // Block body on purpose: a concise arrow returns false for non-Enter keys,
  // which an on* handler treats as preventDefault — killing normal typing.
  $('#name-input').onkeydown = (e) => { if (e.key === 'Enter') go(); };
}

function renderLobby(s) {
  root().innerHTML = `
    <div class="card center-col">
      <h2>Lobby</h2>
      <p class="muted">Waiting for the crew. ${serverSearch && !spotify.connected ? 'Song search works for everyone — connect Spotify (top right) only if you want your Liked Songs / Top Tracks.' : ''}</p>
      <p><b>${s.players.length}</b> player${s.players.length === 1 ? '' : 's'} in.</p>
      ${s.you.isHost
        ? `<button id="start-btn" class="btn primary">Start game</button>
           ${s.players.length < 2 ? '<p class="muted">Solo start works for testing — waiting for more is more fun.</p>' : ''}`
        : `<p class="muted">The host starts the game.</p>`}
    </div>`;
  const b = $('#start-btn');
  if (b) b.onclick = () => api('/api/start', { playerId: store.playerId }).then(poll).catch((e) => toast(e.message));
}

function renderPicking(s) {
  if (!s.youArePicker) {
    root().innerHTML = `
      <div class="card center-col">
        <h2>🎲 Picking the category…</h2>
        <p class="muted">Waiting for <b>${esc(s.pickerLabel)}</b> to choose.</p>
      </div>`;
    return;
  }
  renderPickerUI(s);
}

function renderPickerUI(s) {
  root().innerHTML = `
    <div class="card">
      <h2>${s.round > 1 ? '🏆 You won — pick the next category' : 'Pick the first category'}</h2>
      <h4>Prompts</h4>
      <div class="chips">${PROMPTS.map((c) => `<button class="chip pick" data-c="${esc(c)}">${esc(c)}</button>`).join('')}</div>
      <h4>Genres</h4>
      <div class="chips">${GENRES.map((c) => `<button class="chip pick" data-c="${esc(c)}">${esc(c)}</button>`).join('')}</div>
      <h4>DJ flow</h4>
      <div class="chips">${DJFLOW.map((c) => `<button class="chip pick" data-c="${esc(c)}">${esc(c)}</button>`).join('')}</div>
      <h4>Or make one up</h4>
      <div class="row">
        <input id="custom-cat" autocomplete="off" data-1p-ignore data-lpignore="true" maxlength="80" placeholder="e.g. Songs that mention food">
        <button id="custom-go" class="btn primary">Go</button>
      </div>
    </div>`;
  const choose = (c) => api('/api/category', { playerId: pid(), category: c }).then(poll).catch((e) => toast(e.message));
  root().querySelectorAll('.pick').forEach((b) => (b.onclick = () => choose(b.dataset.c)));
  $('#custom-go').onclick = () => { const v = $('#custom-cat').value.trim(); if (v) choose(v); };
  $('#custom-cat').onkeydown = (e) => { if (e.key === 'Enter') $('#custom-go').click(); };
}

function renderSubmitting(s) {
  staged = null;
  const canSearch = serverSearch || spotify.connected;
  root().innerHTML = `
    <div class="card">
      <div class="cat-banner">Category: <b>${esc(s.category)}</b></div>
      <p class="muted" id="submit-progress"></p>
      <div id="your-pick"></div>
      ${canSearch ? `
        <div class="tabs" id="search-tabs">
          <button class="tab active" data-t="search">🔍 Search</button>
          ${spotify.connected ? `
            <button class="tab" data-t="liked">💚 Liked Songs</button>
            <button class="tab" data-t="top">🔥 Your Top Tracks</button>
          ` : ''}
        </div>
        <input id="search-input" autocomplete="off" data-1p-ignore data-lpignore="true" placeholder="Search for a song…">
        <div id="search-results"></div>
      ` : `
        <p class="muted">Search isn't set up yet — type your song below.</p>
      `}
      <details id="manual-box" ${canSearch ? '' : 'open'}>
        <summary>Type it in manually</summary>
        <div class="row">
          <input id="manual-input" autocomplete="off" data-1p-ignore data-lpignore="true" maxlength="160" placeholder="Song title — Artist">
          <button id="manual-go" class="btn primary">Submit</button>
        </div>
      </details>
      <div class="row center-row"><button id="submit-song-btn" class="btn primary" disabled>Submit song 🎵</button></div>
      ${s.you.isHost ? '<div id="submit-board"></div>' : ''}
    </div>`;
  $('#submit-song-btn').onclick = async () => {
    if (!staged) return;
    const raw = $('#snippet-input') ? $('#snippet-input').value : '';
    const sec = parseTime(raw);
    if (raw.trim() && sec == null) return toast('Snippet start: use m:ss (e.g. 1:05) or seconds');
    const chosen = { ...staged, startSec: sec };
    staged = null; // clear before the post-submit poll so the button state refreshes
    await submitTrack(chosen);
  };
  updateInPlace(s);

  if (canSearch) {
    let tab = 'search', likedCache = null, topCache = null, timer = null;
    const results = $('#search-results');
    const input = $('#search-input');

    // tracks are normalized payloads: {id, name, artists, album, image, url}
    const showTracks = (tracks) => {
      if (!tracks.length) { results.innerHTML = '<p class="muted">No results.</p>'; return; }
      results.innerHTML = tracks.slice(0, 12).map((t, i) => `
        <div class="track-row">
          ${t.image ? `<img src="${esc(t.image)}" alt="">` : '<div class="art-ph">🎵</div>'}
          <div class="tmeta"><b>${esc(t.name)}</b><span class="muted">${esc(t.artists)}</span></div>
          <button class="btn small primary" data-i="${i}">Pick</button>
        </div>`).join('');
      results.querySelectorAll('button[data-i]').forEach((b) => {
        b.onclick = () => stageTrack(tracks[+b.dataset.i]);
      });
    };

    const run = async () => {
      const q = input.value.trim();
      try {
        if (tab === 'search') {
          if (!q) { results.innerHTML = '<p class="muted">Type to search the Spotify catalog.</p>'; return; }
          let tracks;
          if (serverSearch) tracks = (await api('/api/search?q=' + encodeURIComponent(q))).tracks;
          else {
            const d = await spotify.call('/search?type=track&limit=10&q=' + encodeURIComponent(q));
            tracks = (d.tracks?.items || []).map((t) => spotify.trackToPayload(t));
          }
          showTracks(tracks);
        } else {
          if (tab === 'liked' && !likedCache) {
            results.innerHTML = '<p class="muted">Loading your Liked Songs…</p>';
            likedCache = [];
            for (let off = 0; off < 200; off += 50) {
              const d = await spotify.call(`/me/tracks?limit=50&offset=${off}`);
              likedCache.push(...(d.items || []).map((i) => i.track).filter(Boolean).map((t) => spotify.trackToPayload(t)));
              if (!d.next) break;
            }
          }
          if (tab === 'top' && !topCache) {
            results.innerHTML = '<p class="muted">Loading your top tracks…</p>';
            const d = await spotify.call('/me/top/tracks?limit=50&time_range=medium_term');
            topCache = (d.items || []).map((t) => spotify.trackToPayload(t));
          }
          const pool = tab === 'liked' ? likedCache : topCache;
          const f = q.toLowerCase();
          showTracks(pool.filter((t) => !f || t.name.toLowerCase().includes(f) || t.artists.toLowerCase().includes(f)));
        }
      } catch (e) { results.innerHTML = `<p class="muted">Search hiccup — try again. (${esc(e.message)})</p>`; }
    };

    input.oninput = () => { clearTimeout(timer); timer = setTimeout(run, 300); };
    $('#search-tabs').querySelectorAll('.tab').forEach((b) => {
      b.onclick = () => {
        tab = b.dataset.t;
        $('#search-tabs').querySelectorAll('.tab').forEach((x) => x.classList.toggle('active', x === b));
        input.placeholder = tab === 'search' ? 'Search for a song…' : 'Filter…';
        run();
      };
    });
    run();
  }

  $('#manual-go').onclick = () => {
    const v = $('#manual-input').value.trim();
    if (v) submitTrack({ manual: v });
  };
  $('#manual-input').onkeydown = (e) => { if (e.key === 'Enter') $('#manual-go').click(); };
}

async function submitTrack(track) {
  try {
    await api('/api/submit', { playerId: pid(), track });
    toast('Song locked in 🎵 (you can change it until voting starts)', false);
    await poll();
  } catch (e) { toast(e.message); }
}

function trackLabel(t) {
  return t.manual ? esc(t.manual) : `${esc(t.name)} — ${esc(t.artists)}`;
}

// ---------------- snippet helpers ----------------
const SNIP_SEC = 15; // snippet length in seconds, used everywhere (voting, previews, final mix)
function fmtTime(sec) { return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`; }
function parseTime(v) {
  v = (v || '').trim();
  if (!v) return null; // blank = auto
  const m = v.match(/^(\d+):([0-5]?\d)$/);
  if (m) return +m[1] * 60 + +m[2];
  const n = parseInt(v, 10);
  return Number.isFinite(n) && n >= 0 ? n : null;
}
// Auto snippet start: ~35% into the track usually lands near a chorus.
function snippetStart(t) {
  if (t.startSec != null) return t.startSec;
  return t.durationMs ? Math.round((t.durationMs * 0.35) / 1000) : 0;
}

// Stage a chosen song locally; the bottom "Submit song" button locks it in.
function stageTrack(t) {
  staged = t;
  const yp = $('#your-pick');
  if (!yp) return;
  yp.dataset.key = 'staged:' + (t.id || t.name);
  try { if (ypCtl) ypCtl.destroy(); } catch (_) {}
  ypCtl = null;
  yp.innerHTML = `
    <div class="your-pick-banner">🎵 Selected: <b>${trackLabel(t)}</b> <span class="muted">— hit Submit below to lock it in</span>
      ${t.id ? `
        <div id="yp-embed"></div>
        <span class="muted tiny-note">Playing at: <b id="yp-pos">0:00</b> — that's the number to put in the box.</span>
        <div class="row snippet-row">
          <input id="snippet-input" autocomplete="off" data-1p-ignore data-lpignore="true" placeholder="Snippet start m:ss (blank = auto)">
          <button id="yp-preview" class="btn small ghost">▶ Preview</button>
        </div>` : ''}
    </div>`;
  if (t.id) setupYourPickPlayer(t);
  const btn = $('#submit-song-btn');
  if (btn) {
    btn.disabled = false;
    btn.textContent = state && state.yourSubmission ? 'Update my song 🎵' : 'Submit song 🎵';
  }
}

// Your-pick preview: an embed of the submitter's own song so they can find
// the right snippet start; ▶ Preview plays their chosen window.
let ypCtl = null;
function setupYourPickPlayer(t) {
  const slot = $('#yp-embed');
  ensureEmbedApi((embApi) => {
    if (!embApi || !slot || !document.contains(slot)) return;
    const holder = document.createElement('div');
    slot.appendChild(holder);
    embApi.createController(holder, { uri: 'spotify:track:' + t.id, height: 80 }, (ctl) => {
      ypCtl = ctl;
      ctl.addListener('playback_update', (e) => {
        const el = $('#yp-pos');
        if (!el || !e || !e.data) return;
        const ms = e.data.position ?? e.data.progress ?? 0;
        el.textContent = fmtTime(Math.floor(ms / 1000));
      });
      const prev = $('#yp-preview');
      if (prev) prev.onclick = () => {
        const typed = parseTime($('#snippet-input').value);
        const start = typed != null ? typed : snippetStart(t);
        ctl.seek(start);
        ctl.play();
        if (start) setTimeout(() => ctl.seek(start), 900);
        clearTimeout(setupYourPickPlayer._t);
        setupYourPickPlayer._t = setTimeout(() => ctl.pause(), SNIP_SEC * 1000 + 1000);
      };
    });
  });
}

// Spotify iFrame Embed API loader (lets us seek/play/pause embeds for snippets).
let embedApi = null;
const embedApiWaiters = [];
function ensureEmbedApi(cb) {
  if (embedApi) return cb(embedApi);
  embedApiWaiters.push(cb);
  if (embedApiWaiters.length > 1) return; // already loading
  window.onSpotifyIframeApiReady = (api) => {
    embedApi = api;
    embedApiWaiters.splice(0).forEach((f) => f(api));
  };
  const sc = document.createElement('script');
  sc.src = 'https://open.spotify.com/embed/iframe-api/v1';
  sc.async = true;
  sc.onerror = () => embedApiWaiters.splice(0).forEach((f) => f(null));
  document.head.appendChild(sc);
}

function renderVoting(s) {
  root().innerHTML = `
    <div class="card">
      <div class="cat-banner">Category: <b>${esc(s.category)}</b></div>
      <h2>Vote for the best 🗳️</h2>
      <p class="muted" id="vote-progress"></p>
      <p class="muted">Votes are anonymous. You can't vote for your own.</p>
      ${s.you.isHost ? `
        <div class="row center-row">
          <button id="listen-play" class="btn primary">▶ Play the choices (${SNIP_SEC}s each)</button>
          <button id="listen-stop" class="btn ghost hidden">■ Stop</button>
        </div>
        <div id="listen-status" class="cat-banner hidden"></div>
        <div id="listen-progress" class="snip-progress hidden"><div class="prog-track"><div class="prog-fill" id="listen-fill"></div></div><span class="muted" id="listen-time"></span></div>
        <div id="listen-embed" class="hidden"></div>` : ''}
      <div id="ballot">
        ${s.songs.map((song) => `
          <div class="song-card ${song.mine ? 'mine' : ''}" id="song-${song.sid}">
            ${song.track.id
              ? `<div class="embed-slot" data-sid="${esc(song.sid)}" data-tid="${esc(song.track.id)}"></div>`
              : `<div class="manual-track">🎵 ${trackLabel(song.track)}</div>`}
            <div class="song-actions">
              ${song.track.id ? `<button class="btn small ghost snip-btn" data-sid="${esc(song.sid)}" data-start="${snippetStart(song.track)}">▶ ${SNIP_SEC}s snippet</button>` : ''}
              ${song.mine ? '<span class="chip tiny">your pick</span>' : ''}
              ${!song.mine || s.players.length === 1
                ? `<button class="btn small vote-btn" data-sid="${esc(song.sid)}">Vote</button>`
                : ''}
            </div>
            ${song.mine && song.track.id ? `
              <span class="muted tiny-note pos-note">Playing at: <b id="pos-${esc(song.sid)}">0:00</b> — that's the number to put in the box.</span>
              <div class="row snippet-row">
                <input id="vote-snippet" autocomplete="off" data-1p-ignore data-lpignore="true" placeholder="${SNIP_SEC}s snippet start time (m:ss, blank = auto)" value="${song.track.startSec != null ? fmtTime(song.track.startSec) : ''}">
                <button id="vote-snippet-save" class="btn small ghost">Set</button>
              </div>` : ''}
          </div>`).join('')}
      </div>
      ${s.you.isHost ? '<div id="vote-board"></div>' : ''}
    </div>`;
  const lp = $('#listen-play');
  if (lp) {
    lp.onclick = () => playSet(
      (state.songs || []).map((song) => ({ track: song.track, label: `<b>${trackLabel(song.track)}</b>`, sid: song.sid })),
      {
        playBtn: lp,
        stopBtn: $('#listen-stop'),
        status: (h) => { const el = $('#listen-status'); if (el) { el.classList.remove('hidden'); el.innerHTML = h; } },
        highlight: (it) => {
          document.querySelectorAll('#ballot .song-card').forEach((c) => c.classList.remove('now'));
          if (it) { const c = $('#song-' + it.sid); if (c) c.classList.add('now'); }
        },
        embedSlot: () => $('#listen-embed'),
        progress: snipProgress('listen'),
        doneMsg: "That's the ballot — cast your votes! 🗳️",
      });
    $('#listen-stop').onclick = stopSet;
  }
  root().querySelectorAll('.vote-btn').forEach((b) => {
    b.onclick = async () => {
      try {
        await api('/api/vote', { playerId: pid(), sid: b.dataset.sid });
        toast('Vote cast 🗳️ (you can change it until everyone votes)', false);
        await poll();
      } catch (e) { toast(e.message); }
    };
  });
  const snipSave = $('#vote-snippet-save');
  if (snipSave) snipSave.onclick = async () => {
    const v = $('#vote-snippet').value;
    const sec = parseTime(v);
    if (v.trim() && sec == null) return toast('Use m:ss (e.g. 1:05) or seconds');
    try {
      await api('/api/snippet', { playerId: pid(), startSec: sec });
      toast(sec == null ? 'Snippet back to auto ✓' : `Snippet starts at ${fmtTime(sec)} ✓`, false);
      await poll();
    } catch (e) { toast(e.message); }
  };
  wireSnippets();
  updateInPlace(s);
}

// Turn embed slots into controllable players; snippet buttons seek to the start
// point and auto-pause after 30 seconds. Falls back to plain embeds if the
// iFrame API can't load (snippets then use Spotify's own preview clip).
function wireSnippets() {
  const slots = [...root().querySelectorAll('.embed-slot')];
  if (!slots.length) return;
  const controllers = {};
  let ready = false;

  const fallback = () => {
    // Only touch the slots captured by THIS call — a stale timer from a previous
    // screen must not convert or strip controls on the current one.
    const sids = new Set(slots.map((el) => el.dataset.sid));
    slots.forEach((el) => {
      if (!document.contains(el)) return;
      el.outerHTML = `<iframe src="https://open.spotify.com/embed/track/${esc(el.dataset.tid)}" width="100%" height="80" frameborder="0" loading="lazy" allow="encrypted-media"></iframe>`;
    });
    document.querySelectorAll('.snip-btn').forEach((b) => { if (sids.has(b.dataset.sid)) b.remove(); });
  };

  ensureEmbedApi((api) => {
    if (!api) return fallback();
    ready = true;
    slots.forEach((el) => {
      const sid = el.dataset.sid, tid = el.dataset.tid;
      const holder = document.createElement('div');
      el.appendChild(holder);
      api.createController(holder, { uri: 'spotify:track:' + tid, height: 80 }, (c) => {
        controllers[sid] = c;
        c.addListener('playback_update', (e) => {
          const posEl = $('#pos-' + sid);
          if (!posEl || !e || !e.data) return;
          const ms = e.data.position ?? e.data.progress ?? 0;
          posEl.textContent = fmtTime(Math.floor(ms / 1000));
        });
      });
    });
  });
  setTimeout(() => { if (!ready) fallback(); }, 4000); // script hung / blocked

  let active = null, stopTimer = null;
  root().querySelectorAll('.snip-btn').forEach((b) => {
    b.onclick = () => {
      const c = controllers[b.dataset.sid];
      if (!c) return toast('Player still loading — try again in a second', false);
      if (active && active !== c) active.pause();
      active = c;
      const start = +b.dataset.start || 0;
      c.seek(start);
      c.play();
      if (start) setTimeout(() => c.seek(start), 900); // some embeds start at 0 on first play
      clearTimeout(stopTimer);
      stopTimer = setTimeout(() => c.pause(), SNIP_SEC * 1000 + 1000);
    };
  });
}

function renderResults(s) {
  const sorted = s.songs.slice().sort((a, b) => b.votes - a.votes);
  root().innerHTML = `
    <div class="card">
      <div class="cat-banner">Category: <b>${esc(s.category)}</b></div>
      <h2>Results 🏁</h2>
      ${s.tieCount > 1 ? `<div class="cat-banner">🎲 <b>${s.tieCount}-way tie</b> at the top — winner drawn at random!</div>` : ''}
      ${s.youWon
        ? `<div class="win-banner">🏆 <b>You won this round!</b>${s.tieCount > 1 ? ' (won the random draw)' : ''}${s.revealed ? '' : ' Keep a poker face while they guess. 🤫'}</div>`
        : s.revealed && s.winnerName
          ? `<div class="win-banner">🏆 <b>${esc(s.winnerName)}</b> takes the round!${s.tieCount > 1 ? ' (random draw)' : ''}</div>`
          : `<div class="win-banner">🕵️ We have a winning song — but <b>whose is it?</b> Take your guesses!</div>`}
      ${s.you.isHost && !s.revealed ? '<p class="center"><button id="reveal-btn" class="btn primary">🎭 Reveal whose songs these are</button></p>' : ''}
      <div id="ballot">
        ${sorted.map((song) => `
          <div class="song-card ${song.winner ? 'winner' : ''}">
            <div class="result-row">
              <span class="vote-count">${song.votes}</span>
              <div class="tmeta">
                ${song.winner ? '🏆 ' : ''}<b>${trackLabel(song.track)}</b>
                ${song.tied ? '<span class="chip tiny tie-chip">🎲 tied</span>' : ''}
                <span class="muted">${song.by ? `${esc(song.by)}'s pick` : 'whose pick…?'}${song.mine ? ' <span class="chip tiny">you</span>' : ''}</span>
              </div>
            </div>
            ${song.track.id ? `<div class="embed-slot" data-sid="${esc(song.sid)}" data-tid="${esc(song.track.id)}"></div>` : ''}
          </div>`).join('')}
      </div>
      ${s.youWon
        ? '<button id="next-btn" class="btn primary">You won — pick the next category →</button>'
        : s.you.isHost
          ? '<button id="next-btn" class="btn small ghost">Next round → (winner picks)</button>'
          : '<p class="muted center">Waiting for the winner to pick the next category…</p>'}
    </div>`;
  const b = $('#next-btn');
  if (b) b.onclick = () => api('/api/next', { playerId: pid() }).then(poll).catch((e) => toast(e.message));
  const rv = $('#reveal-btn');
  if (rv) rv.onclick = () => api('/api/reveal', { playerId: store.playerId }).then(poll).catch((e) => toast(e.message));
  wireSnippets(); // embed players (artwork + play) on the result cards
}

// ---------------- Final Mix (DJ set of round winners) ----------------
const mix = { running: false, stop: false, player: null, deviceId: null, embedCtl: null, embedHost: null };

function renderFinale(s) {
  mix.stop = true; // cancel any prior run's loop before rebuilding the screen
  const list = s.history;
  const playable = list.filter((h) => h.track.id).length;
  root().innerHTML = `
    <div class="card">
      <h2>🎬 The Final Mix</h2>
      <p class="muted">${list.length} round winner${list.length === 1 ? '' : 's'} · ${SNIP_SEC}s each · ~${Math.round((list.length * SNIP_SEC / 60) * 10) / 10} min set</p>
      <div id="mix-status" class="cat-banner hidden"></div>
      <div id="mix-progress" class="snip-progress hidden"><div class="prog-track"><div class="prog-fill" id="mix-fill"></div></div><span class="muted" id="mix-time"></span></div>
      <div id="setlist">
        ${list.map((h, i) => `
          <div class="song-card" id="mix-${i}">
            <div class="result-row">
              <span class="mix-round">${esc(h.category)}</span>
              ${h.track.image ? `<img class="mix-art" src="${esc(h.track.image)}" alt="">` : '<div class="art-ph mix-art">🎵</div>'}
              <div class="tmeta">
                <b>${trackLabel(h.track)}</b>
                <span class="muted">Round ${h.round}${h.by ? ` · ${esc(h.by)}` : ''}${h.track.id ? ` · starts ${fmtTime(snippetStart(h.track))} · auto-fade` : ' · manual entry — skipped in playback'}</span>
              </div>
            </div>
          </div>`).join('')}
      </div>
      <div class="row center-row">
        <button id="mix-play" class="btn primary" ${playable ? '' : 'disabled'}>▶ Play the Final Mix</button>
        <button id="mix-stop" class="btn ghost hidden">■ Stop</button>
      </div>
      <p class="muted center" id="mix-hint">${spotify.connected
        ? 'Connected — full tracks with DJ fades if this account has Premium; otherwise falls back to preview players.'
        : 'Tip for the DJ laptop: Connect Spotify (top right) for full-track playback with volume fades. Without it, preview clips with hard cuts.'}</p>
      ${s.playlistUrl
        ? `<p class="center"><a id="playlist-link" class="btn small ghost" href="${esc(s.playlistUrl)}" target="_blank" rel="noopener">🔗 Open the game playlist</a></p>`
        : spotify.connected ? `<p class="center"><button id="playlist-btn" class="btn small ghost">➕ Create Spotify playlist${(s.allSongs || []).length ? ` (all ${(s.allSongs || []).filter((a) => a.track.id).length} songs)` : ''}</button></p>` : ''}
      ${(s.allSongs || []).length ? `
        <details id="all-songs">
          <summary>All submissions (${s.allSongs.length})</summary>
          ${s.allSongs.map((a) => `
            <div class="track-row">
              ${a.track.image ? `<img src="${esc(a.track.image)}" alt="">` : '<div class="art-ph">🎵</div>'}
              <div class="tmeta">
                <b>${a.winner ? '🏆 ' : ''}${trackLabel(a.track)}</b>
                <span class="muted">Round ${a.round} · ${esc(a.category)} · ${esc(a.by)}</span>
              </div>
            </div>`).join('')}
        </details>` : ''}
      <div id="mix-embed" class="hidden"></div>
    </div>`;
  const plb = $('#playlist-btn');
  if (plb) plb.onclick = () => createFinalPlaylist(list);
  $('#mix-play').onclick = () => playSet(
    list.map((h, i) => ({ track: h.track, label: `<b>${trackLabel(h.track)}</b> <span class="muted">(${esc(h.category)})</span>`, idx: i })),
    {
      playBtn: $('#mix-play'),
      stopBtn: $('#mix-stop'),
      status: (h) => { const el = $('#mix-status'); if (el) { el.classList.remove('hidden'); el.innerHTML = h; } },
      highlight: (it) => {
        document.querySelectorAll('#setlist .song-card').forEach((el) => el.classList.remove('now'));
        if (it) { const c = $('#mix-' + it.idx); if (c) c.classList.add('now'); }
      },
      embedSlot: () => $('#mix-embed'),
      progress: snipProgress('mix'),
      doneMsg: '🎉 That was your set — great game!',
    });
  $('#mix-stop').onclick = stopSet;
}

// Create a real Spotify playlist of the round winners and share its URL with the room.
async function createFinalPlaylist(list) {
  // Every submission from every round (winners first within each round);
  // fall back to just the winners for games recorded before allSongs existed.
  const source = (state && state.allSongs && state.allSongs.length)
    ? [...state.allSongs].sort((a, b) => a.round - b.round || (b.winner ? 1 : 0) - (a.winner ? 1 : 0))
    : list;
  const seen = new Set();
  const uris = [];
  for (const a of source) {
    if (a.track.id && !seen.has(a.track.id)) { seen.add(a.track.id); uris.push('spotify:track:' + a.track.id); }
  }
  if (!uris.length) return toast('No Spotify tracks in the setlist');
  const btn = $('#playlist-btn');
  if (btn) { btn.disabled = true; btn.textContent = 'Creating…'; }
  try {
    const me = await spotify.call('/me');
    const pl = await spotify.post(`/users/${encodeURIComponent(me.id)}/playlists`, {
      name: 'Song Showdown — ' + new Date().toLocaleDateString(),
      description: `${uris.length} songs from ${list.length} rounds · ` + list.map((h) => h.category).join(' · '),
      public: true,
    });
    await spotify.post(`/playlists/${pl.id}/tracks`, { uris });
    const url = (pl.external_urls && pl.external_urls.spotify) || 'https://open.spotify.com/playlist/' + pl.id;
    await api('/api/playlist', { playerId: store.playerId, url });
    toast('Playlist created ✓', false);
    await poll();
  } catch (e) {
    toast('Playlist failed: ' + e.message + ' — disconnect & reconnect Spotify to grant playlist access, then retry');
    if (btn) { btn.disabled = false; btn.textContent = '➕ Create Spotify playlist'; }
  }
}

const waitMs = (ms) => new Promise((r) => {
  const t0 = Date.now();
  const iv = setInterval(() => { if (mix.stop || Date.now() - t0 >= ms) { clearInterval(iv); r(); } }, 100);
});

// Progress hook: fills the bar + "0:07 / 0:15" while a snippet plays; el<0 hides it.
function snipProgress(prefix) {
  return (el, total) => {
    const box = $('#' + prefix + '-progress');
    if (!box) return;
    if (el < 0) { box.classList.add('hidden'); return; }
    box.classList.remove('hidden');
    const fill = $('#' + prefix + '-fill'), tm = $('#' + prefix + '-time');
    if (fill) fill.style.width = Math.round((el / total) * 100) + '%';
    if (tm) tm.textContent = `${fmtTime(Math.floor(el / 1000))} / ${fmtTime(Math.floor(total / 1000))}`;
  };
}

function stopSet() {
  mix.stop = true;
  if (mix.player) mix.player.pause().catch(() => {});
  if (mix.embedCtl) mix.embedCtl.pause();
}

// Shared DJ engine: plays each item's snippet (SNIP_SEC) in order. ui supplies the
// screen-specific hooks (finale setlist vs. voting listening party).
async function playSet(items, ui) {
  if (mix.running) return;
  const playable = items.filter((it) => it.track.id);
  if (!playable.length) return toast('No Spotify tracks to play');
  mix.running = true; mix.stop = false;
  ui.playBtn.classList.add('hidden');
  ui.stopBtn.classList.remove('hidden');

  let sdkOk = false;
  if (spotify.connected) {
    ui.status('Warming up the decks…');
    sdkOk = await initMixPlayer().catch(() => false);
    if (!sdkOk) toast('No Premium playback — using preview players (reconnect Spotify if you upgraded)', false);
  }
  try {
    for (let i = 0; i < playable.length; i++) {
      if (mix.stop) break;
      const it = playable[i];
      ui.highlight(it);
      ui.status(`Now playing ${i + 1}/${playable.length}: ${it.label}`);
      const t0 = Date.now();
      const tick = setInterval(() => {
        if (ui.progress) ui.progress(Math.min(SNIP_SEC * 1000, Date.now() - t0), SNIP_SEC * 1000);
      }, 200);
      try {
        if (sdkOk) await sdkPlaySnippet(it.track);
        else await embedPlaySnippet(it.track, ui.embedSlot());
      } finally { clearInterval(tick); }
    }
    ui.status(mix.stop ? 'Stopped.' : ui.doneMsg || 'Done!');
  } catch (e) {
    ui.status('Playback hiccup: ' + esc(e.message));
  } finally {
    mix.running = false;
    if (mix.player) mix.player.pause().catch(() => {});
    ui.highlight(null);
    if (ui.progress) ui.progress(-1, 0);
    ui.playBtn.classList.remove('hidden');
    ui.stopBtn.classList.add('hidden');
  }
}

// --- SDK path: full tracks + real volume fades (needs Premium + streaming scope) ---
function initMixPlayer() {
  return new Promise((resolve, reject) => {
    if (mix.player && mix.deviceId) return resolve(true);
    const boot = () => {
      const p = new Spotify.Player({ name: 'Song Showdown DJ', getOAuthToken: (cb) => cb(spotify.token), volume: 0 });
      p.addListener('ready', ({ device_id }) => { mix.player = p; mix.deviceId = device_id; resolve(true); });
      ['initialization_error', 'authentication_error', 'account_error'].forEach((ev) => p.addListener(ev, () => reject(new Error(ev))));
      p.connect();
      setTimeout(() => reject(new Error('SDK timeout')), 8000);
    };
    if (window.Spotify) return boot();
    window.onSpotifyWebPlaybackSDKReady = boot;
    const sc = document.createElement('script');
    sc.src = 'https://sdk.scdn.co/spotify-player.js';
    sc.onerror = () => reject(new Error('SDK load failed'));
    document.head.appendChild(sc);
  });
}

async function playerApi(pathAndQuery, body) {
  const res = await fetch('https://api.spotify.com/v1/me/player' + pathAndQuery, {
    method: 'PUT',
    headers: { Authorization: 'Bearer ' + spotify.token, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok && res.status !== 204) throw new Error('player API ' + res.status);
}

async function rampVolume(from, to, ms) {
  const steps = Math.max(1, Math.round(ms / 150));
  for (let i = 1; i <= steps; i++) {
    if (mix.stop) return;
    await mix.player.setVolume(from + ((to - from) * i) / steps).catch(() => {});
    await new Promise((r) => setTimeout(r, ms / steps));
  }
}

const FADE_MS = 2000; // auto-generated DJ fade in/out for every snippet

async function sdkPlaySnippet(t) {
  const start = snippetStart(t);
  const fadeIn = FADE_MS;
  const fadeOut = FADE_MS;
  await mix.player.setVolume(0).catch(() => {});
  await playerApi('/play?device_id=' + mix.deviceId, { uris: ['spotify:track:' + t.id], position_ms: start * 1000 });
  await rampVolume(0, 1, fadeIn);
  await waitMs(Math.max(0, SNIP_SEC * 1000 - fadeIn - fadeOut));
  await rampVolume(1, 0, fadeOut);
  await playerApi('/pause?device_id=' + mix.deviceId);
}

// --- Fallback: one reusable embed player, hard cuts (previews if logged out) ---
function embedPlaySnippet(t, slot) {
  return new Promise((resolve) => {
    if (!slot || !document.contains(slot)) return resolve();
    slot.classList.remove('hidden');
    // The embed lives inside one screen's slot — if that screen was re-rendered, rebuild it.
    if (mix.embedHost && !document.contains(mix.embedHost)) {
      try { mix.embedCtl.destroy(); } catch (_) {}
      mix.embedCtl = null; mix.embedHost = null;
    }
    const go = (ctl) => {
      const start = snippetStart(t);
      ctl.seek(start);
      ctl.play();
      if (start) setTimeout(() => ctl.seek(start), 900);
      waitMs(SNIP_SEC * 1000).then(() => { ctl.pause(); resolve(); });
    };
    if (mix.embedCtl) { mix.embedCtl.loadUri('spotify:track:' + t.id); setTimeout(() => go(mix.embedCtl), 600); return; }
    ensureEmbedApi((api) => {
      if (!api) { toast('Spotify player blocked — skipping playback'); return resolve(); }
      const holder = document.createElement('div');
      slot.appendChild(holder);
      mix.embedHost = slot;
      api.createController(holder, { uri: 'spotify:track:' + t.id, height: 80 }, (ctl) => { mix.embedCtl = ctl; go(ctl); });
    });
  });
}

// Targeted refreshes that don't rebuild the DOM (keeps inputs + embeds alive).
function updateInPlace(s) {
  const sp = $('#submit-progress');
  if (sp && s.phase === 'submitting') sp.textContent = `${s.submittedCount}/${s.players.length} songs in`;
  if (s.phase === 'submitting') {
    const sb = $('#submit-board');
    if (sb) sb.innerHTML = '<span class="muted">Songs in:</span> ' + s.players.map((p) =>
      `<span class="vb ${p.submitted ? 'in' : ''}">${esc(p.name)} ${p.submitted ? '✓' : '…'}</span>`).join('');
    const btn = $('#submit-song-btn');
    if (btn && !staged) {
      btn.disabled = true;
      btn.textContent = s.yourSubmission ? 'Submitted ✓ (pick another to swap)' : 'Submit song 🎵';
    }
  }
  const yp = $('#your-pick');
  if (yp && s.phase === 'submitting' && !staged) {
    // Only rebuild when the submission itself changes — keeps the snippet input alive while typing.
    const ypKey = JSON.stringify(s.yourSubmission || null);
    if (yp.dataset.key !== ypKey) {
      yp.dataset.key = ypKey;
      const t = s.yourSubmission;
      try { if (ypCtl) ypCtl.destroy(); } catch (_) {}
      ypCtl = null;
      if (!t) yp.innerHTML = '';
      else {
        yp.innerHTML = `
          <div class="your-pick-banner">✓ Your pick: <b>${trackLabel(t)}</b> <span class="muted">(pick another to swap)</span>
            ${t.id ? `
              <div id="yp-embed"></div>
              <span class="muted tiny-note">Playing at: <b id="yp-pos">0:00</b> — that's the number to put in the box.</span>
              <div class="row snippet-row">
                <input id="snippet-input" autocomplete="off" data-1p-ignore data-lpignore="true" placeholder="Snippet start m:ss (blank = auto)" value="${t.startSec != null ? fmtTime(t.startSec) : ''}">
                <button id="snippet-save" class="btn small ghost">Set</button>
                <button id="yp-preview" class="btn small ghost">▶ Preview</button>
              </div>
              <span class="muted tiny-note">Voting plays a ${SNIP_SEC}s snippet — auto-picked${t.startSec != null ? `, yours starts at ${fmtTime(t.startSec)}` : ''} unless you set a start time.</span>
            ` : ''}
          </div>`;
        const save = $('#snippet-save');
        if (save) save.onclick = () => {
          const v = $('#snippet-input').value;
          const sec = parseTime(v);
          if (v.trim() && sec == null) return toast('Use m:ss (e.g. 1:05) or seconds');
          submitTrack({ ...t, startSec: sec });
        };
        if (t.id) setupYourPickPlayer(t);
      }
    }
  }
  const vp = $('#vote-progress');
  if (vp && s.phase === 'voting') vp.textContent = `${s.votedCount}/${s.players.length} votes in`;
  if (s.phase === 'voting') {
    root().querySelectorAll('.vote-btn').forEach((b) => {
      const chosen = s.yourVote === b.dataset.sid;
      b.textContent = chosen ? 'Voted ✓' : 'Vote';
      b.classList.toggle('primary', chosen);
    });
    const vb = $('#vote-board');
    if (vb) vb.innerHTML = '<span class="muted">Votes in:</span> ' + s.players.map((p) =>
      `<span class="vb ${p.voted ? 'in' : ''}">${esc(p.name)} ${p.voted ? '✓' : '…'}</span>`).join('');
    // Snippet starts can change mid-vote — refresh the play buttons (never the input).
    (s.songs || []).forEach((song) => {
      const b = root().querySelector(`.snip-btn[data-sid="${song.sid}"]`);
      if (b) b.dataset.start = snippetStart(song.track);
    });
  }
}

// ---------------- boot ----------------
(async function boot() {
  try {
    const c = await api('/api/config');
    clientId = c.clientId || '';
    serverSearch = !!c.serverSearch;
  } catch (_) {}
  await spotify.handleCallback();
  if (clientId) renderSpotifyBtn();
  await poll();
  setInterval(poll, 2000);
})();
