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
  botAutopilot(s); // fire-and-forget; serializes itself via autopilot.busy
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

// ---------------- bot DJ brain (category-aware test submissions) ----------------
// Seeds are real on-category songs, written punctuation-free (Spotify search ignores it).
// Bots search a shuffled plan and each takes a different track (dedupe via `used`).
const BOT_WORDS = ['love', 'night', 'dance', 'heart', 'fire', 'time', 'baby', 'girl', 'city', 'rain',
  'sun', 'road', 'gold', 'blue', 'dream', 'moon', 'home', 'light', 'star', 'sweet', 'wild', 'crazy', 'summer', 'money'];
const BOT_SEEDS = {
  'Instrumentals': ['green onions booker t', 'sleepwalk santo and johnny', 'frankenstein edgar winter group', 'jessica allman brothers', 'misirlou dick dale', 'chameleon herbie hancock', 'yyz rush', 'cliffs of dover eric johnson', 'pick up the pieces average white band', 'soul bossa nova quincy jones', 'apache incredible bongo band', 'rumble link wray', 'albatross fleetwood mac', 'europa santana', 'axel f harold faltermeyer', 'linus and lucy vince guaraldi'],
  'Songs with no vocals': ['strobe deadmau5', 'time hans zimmer', 'clair de lune debussy', 'gymnopedie no 1 satie', 'divenire ludovico einaudi', 'first breath after coma explosions in the sky', 'your hand in mine explosions in the sky', 'nuvole bianche einaudi', 'midnight in a perfect world dj shadow', 'teen town weather report', 'moanin art blakey', 'flim aphex twin', 'loud pipes ratatat', 'sunset lover petit biscuit', 'intro the xx', 'comptine dun autre ete yann tiersen'],
  'Covers': ['hurt johnny cash', 'all along the watchtower jimi hendrix', 'hallelujah jeff buckley', 'respect aretha franklin', 'i will always love you whitney houston', 'valerie amy winehouse mark ronson', 'tainted love soft cell', 'nothing compares 2 u sinead oconnor', 'twist and shout the beatles', 'proud mary ike and tina turner', 'knockin on heavens door guns n roses', 'me and bobby mcgee janis joplin', 'blinded by the light manfred mann', 'take me to the river talking heads', 'red red wine ub40', 'always on my mind pet shop boys'],
  'Songs under 2 minutes': ['fell in love with a girl white stripes', 'judy is a punk ramones', 'golden slumbers beatles', 'i will beatles', 'old town road lil nas x', 'panini lil nas x', 'jocelyn flores xxxtentacion', 'white riot the clash', 'minor threat', 'descendents milo goes to college', 'wire pink flag', 'guided by voices bee thousand', 'ramones', 'misfits', 'buddy holly', 'beach boys'],
  'Guilty pleasures': ['barbie girl aqua', 'never gonna give you up rick astley', 'call me maybe carly rae jepsen', 'mmmbop hanson', 'what makes you beautiful one direction', 'party in the usa miley cyrus', 'cotton eye joe rednex', 'wannabe spice girls', 'friday rebecca black', 'baby justin bieber', 'macarena los del rio', 'who let the dogs out baha men', 'im too sexy right said fred', 'oops i did it again britney spears', 'blue da ba dee eiffel 65', 'ice ice baby vanilla ice'],
  'Pump me up': ['eye of the tiger survivor', 'till i collapse eminem', 'thunderstruck acdc', 'lose yourself eminem', 'remember the name fort minor', 'stronger kanye west', 'cant hold us macklemore', 'welcome to the jungle guns n roses', 'power kanye west', 'jump around house of pain', 'enter sandman metallica', 'x gon give it to ya dmx', 'all i do is win dj khaled', 'centuries fall out boy', 'harder better faster stronger daft punk', 'seven nation army the white stripes'],
  'Earworms': ['take on me a-ha', 'call me maybe carly rae jepsen', 'bad guy billie eilish', 'uptown funk mark ronson', 'shake it off taylor swift', 'cant stop the feeling justin timberlake', 'happy pharrell williams', 'seven nation army white stripes', 'gangnam style psy', 'barbie girl aqua', 'who let the dogs out baha men', 'dance monkey tones and i', 'somebody that i used to know gotye', 'moves like jagger maroon 5', 'cant get you out of my head kylie minogue', 'mmmbop hanson'],
  'Movie soundtrack': ['my heart will go on celine dion', 'stayin alive bee gees', 'footloose kenny loggins', 'ghostbusters ray parker jr', 'time of my life bill medley', 'lose yourself eminem', 'skyfall adele', 'shallow lady gaga bradley cooper', 'dont you forget about me simple minds', 'i will always love you whitney houston', 'circle of life elton john', 'danger zone kenny loggins', 'holding out for a hero bonnie tyler', 'unchained melody the righteous brothers', 'city of stars ryan gosling', 'oh yeah yello'],
  'One-word title': ['hello adele', 'yellow coldplay', 'believe cher', 'africa toto', 'royals lorde', 'umbrella rihanna', 'happy pharrell williams', 'faith george michael', 'thriller michael jackson', 'imagine john lennon', 'respect aretha franklin', 'jolene dolly parton', 'valerie amy winehouse', 'dreams fleetwood mac', 'creep radiohead', 'wonderwall oasis'],
  'Songs to cry to': ['someone like you adele', 'fix you coldplay', 'hurt johnny cash', 'tears in heaven eric clapton', 'everybody hurts rem', 'skinny love bon iver', 'liability lorde', 'when the partys over billie eilish', 'nothing compares 2 u sinead oconnor', 'yesterday the beatles', 'all i want kodaline', 'the night we met lord huron', 'say something a great big world', 'jealous labrinth', 'i cant make you love me bonnie raitt', 'fast car tracy chapman'],
  'Road trip': ['life is a highway tom cochrane', 'take it easy eagles', 'go your own way fleetwood mac', 'sweet home alabama lynyrd skynyrd', 'born to run bruce springsteen', 'shut up and drive rihanna', 'send me on my way rusted root', 'ride twenty one pilots', 'on the road again willie nelson', 'route 66 chuck berry', 'free fallin tom petty', 'runnin down a dream tom petty', 'radar love golden earring', 'little red corvette prince', 'take me home country roads john denver', 'midnight rider allman brothers'],
  'Karaoke banger': ['dont stop believin journey', 'bohemian rhapsody queen', 'sweet caroline neil diamond', 'livin on a prayer bon jovi', 'i want it that way backstreet boys', 'wonderwall oasis', 'mr brightside the killers', 'total eclipse of the heart bonnie tyler', 'shallow lady gaga bradley cooper', 'my heart will go on celine dion', 'friends in low places garth brooks', 'love shack the b-52s', 'summer nights john travolta olivia newton-john', 'aint no mountain high enough marvin gaye', 'like a prayer madonna', 'torn natalie imbruglia'],
  'Best opening 10 seconds': ['smells like teen spirit nirvana', 'seven nation army white stripes', 'sweet child o mine guns n roses', 'money for nothing dire straits', 'baba oriley the who', 'crazy in love beyonce', 'blinding lights the weeknd', 'under pressure queen david bowie', 'back in black acdc', 'billie jean michael jackson', 'welcome to the jungle guns n roses', 'my girl the temptations', 'superstition stevie wonder', 'come as you are nirvana', 'in da club 50 cent', 'bulls on parade rage against the machine'],
  'Song you loved in high school': ['mr brightside the killers', 'i write sins not tragedies panic at the disco', 'welcome to the black parade my chemical romance', 'stacys mom fountains of wayne', 'in the end linkin park', 'sk8er boi avril lavigne', 'crank that soulja boy', 'hot n cold katy perry', 'yeah usher', 'complicated avril lavigne', 'all star smash mouth', 'the middle jimmy eat world', 'a thousand miles vanessa carlton', 'ms jackson outkast', 'say it aint so weezer', 'flagpole sitta harvey danger'],
  'Best song from a bad artist': ['how you remind me nickelback', 'all star smash mouth', 'ice ice baby vanilla ice', 'blue da ba dee eiffel 65', 'butterfly crazy town', 'with arms wide open creed', 'break stuff limp bizkit', 'photograph nickelback', 'my own worst enemy lit', 'the reason hoobastank', 'kryptonite 3 doors down', 'absolutely story of a girl nine days', 'follow me uncle kracker', 'she hates me puddle of mudd', 'rollin limp bizkit', 'bad day daniel powter'],
  'Hidden gem (under 1M plays)': ['b side deep cut', 'bedroom pop demo', 'obscure soul 45', 'private press funk', 'japanese city pop rare', 'library music groove', 'psych folk obscure', 'lo-fi home recording', 'yacht rock obscure', 'forgotten one hit wonder', 'garage rock nuggets', 'rare groove 1974', 'cassette culture synth', 'minor hit 1983', 'deep cut album track', 'cult classic indie'],
  'Best duet or collab': ['under pressure queen david bowie', 'empire state of mind jay-z alicia keys', 'shallow lady gaga bradley cooper', 'islands in the stream kenny rogers dolly parton', 'dont go breaking my heart elton john kiki dee', 'aint no mountain high enough marvin gaye tammi terrell', 'telephone lady gaga beyonce', 'airplanes bob hayley williams', 'ebony and ivory paul mccartney stevie wonder', 'the boy is mine brandy monica', 'crazy in love beyonce jay-z', 'numb encore jay-z linkin park', 'walk this way run dmc aerosmith', 'lady marmalade christina aguilera pink', 'senorita shawn mendes camila cabello', 'rain on me lady gaga ariana grande'],
  'Song in another language': ['despacito luis fonsi', 'la vie en rose edith piaf', 'gangnam style psy', '99 luftballons nena', 'dragostea din tei o-zone', 'la bamba ritchie valens', 'bamboleo gipsy kings', 'sukiyaki kyu sakamoto', 'macarena los del rio', 'ai se eu te pego michel telo', 'alors on danse stromae', 'ca plane pour moi plastic bertrand', 'rock me amadeus falco', 'la camisa negra juanes', 'danza kuduro don omar', 'volare domenico modugno'],
  'Warm-up opener': ['intro the xx', 'midnight city m83', 'sunset lover petit biscuit', 'nightcall kavinsky', 'odessa caribou', 'porcelain moby', 'genesis justice', 'kids mgmt', 'flashing lights kanye west', 'electric feel mgmt', 'digital love daft punk', 'tieduprightnow parcels', 'borderline tame impala', 'doses and mimosas cherub', 'jubel klingande', 'firestone kygo'],
  'Build the energy': ['one more time daft punk', 'dance justice', 'around the world daft punk', 'galvanize chemical brothers', 'move your feet junior senior', 'dont you worry child swedish house mafia', 'pump up the jam technotronic', 'blue monday new order', 'i wanna dance with somebody whitney houston', 'september earth wind and fire', 'lets groove earth wind and fire', 'good as hell lizzo', 'canned heat jamiroquai', 'treasure bruno mars', 'rather be clean bandit', 'get lucky daft punk pharrell'],
  'Peak-hour banger': ['losing it fisher', 'titanium david guetta sia', 'levels avicii', 'animals martin garrix', 'turn down for what dj snake lil jon', 'satisfaction benny benassi', 'bangarang skrillex', 'sandstorm darude', 'one kiss calvin harris dua lipa', 'dont you worry child swedish house mafia', 'wake me up avicii', 'ghosts n stuff deadmau5', 'in my mind dynoro', 'freed from desire gala', 'cola camelphat', 'pjanoo eric prydz'],
  'The drop': ['scary monsters and nice sprites skrillex', 'bangarang skrillex', 'harlem shake baauer', 'core rl grime', 'turn down for what dj snake', 'first of the year skrillex', 'internet friends knife party', 'crave you adventure club remix', 'cinema benny benassi skrillex remix', 'get low dillon francis dj snake', 'tsunami dvbbs borgeous', 'bass head bassnectar', 'promises nero skrillex remix', 'i cant stop flux pavilion', 'crab rave noisestorm'],
  'Smooth groove': ['get lucky daft punk', 'redbone childish gambino', 'passionfruit drake', 'best part daniel caesar', 'smooth operator sade', 'golden jill scott', 'lovely day bill withers', 'rock with you michael jackson', 'cranes in the sky solange', 'pink white frank ocean', 'get you daniel caesar kali uchis', 'prototype outkast', 'adorn miguel', 'goodie bag still woozy', 'sunday best surfaces'],
  'Sunset set': ['sun is shining bob marley', 'island in the sun weezer', 'kokomo beach boys', 'banana pancakes jack johnson', 'santeria sublime', 'three little birds bob marley', 'sunset lover petit biscuit', 'california stars billy bragg wilco', 'summertime dj jazzy jeff fresh prince', 'feel it still portugal the man', 'electric relaxation a tribe called quest', 'doin time sublime', 'sunday morning maroon 5', 'put your records on corinne bailey rae', 'better together jack johnson', 'the girl from ipanema stan getz'],
  'Cooldown': ['breathe telepopmusik', 'teardrop massive attack', 'porcelain moby', 'holocene bon iver', 'cold little heart michael kiwanuka', 'night owl galimatias', 'flightless bird american mouth iron and wine', 'bloom odesza', 'youth daughter', 'to build a home the cinematic orchestra', 're stacks bon iver', 'first day of my life bright eyes', 'georgia vance joy', 'bloom the paper kites', 'night trouble petit biscuit', 'skinny love birdy'],
  'After-hours (2am)': ['after hours the weeknd', 'nikes frank ocean', 'the hills the weeknd', 'marvins room drake', 'often the weeknd', 'earned it the weeknd', 'novacane frank ocean', 'all the time jeremih', 'wicked games the weeknd', 'crew goldlink', 'sober childish gambino', 'come and see me partynextdoor', 'lost frank ocean', 'the morning the weeknd', 'streets doja cat', 'after dark mr kitty'],
  'Set closer': ['closing time semisonic', 'dont stop believin journey', 'last dance donna summer', 'new york new york frank sinatra', 'piano man billy joel', 'all these things that ive done the killers', 'time of your life green day', 'bittersweet symphony the verve', 'hey jude the beatles', 'dont look back in anger oasis', 'mr blue sky electric light orchestra', 'wagon wheel darius rucker', 'purple rain prince', 'free bird lynyrd skynyrd', 'all you need is love the beatles', 'sweet caroline neil diamond'],
  '80s': ['take on me a-ha', 'billie jean michael jackson', 'sweet dreams eurythmics', 'livin on a prayer bon jovi', 'like a virgin madonna', 'dont you want me human league', 'girls just want to have fun cyndi lauper', 'every breath you take the police', 'dont stop believin journey', 'africa toto', 'everybody wants to rule the world tears for fears', 'wake me up before you go-go wham', 'jessies girl rick springfield', 'karma chameleon culture club', 'under pressure queen david bowie', 'walk like an egyptian the bangles'],
  '90s': ['smells like teen spirit nirvana', 'wonderwall oasis', 'no diggity blackstreet', 'waterfalls tlc', 'wannabe spice girls', 'losing my religion rem', 'juicy the notorious big', 'torn natalie imbruglia', 'creep radiohead', 'black or white michael jackson', 'gin and juice snoop dogg', 'baby one more time britney spears', 'basket case green day', 'zombie the cranberries', 'killing me softly fugees', 'all star smash mouth'],
  '2000s': ['hey ya outkast', 'crazy in love beyonce', 'in da club 50 cent', 'mr brightside the killers', 'toxic britney spears', 'hips dont lie shakira', 'seven nation army white stripes', 'umbrella rihanna', 'gold digger kanye west', 'since u been gone kelly clarkson', 'yeah usher', 'boulevard of broken dreams green day', 'hot in herre nelly', 'complicated avril lavigne', 'feel good inc gorillaz', 'i gotta feeling black eyed peas'],
  'Hip-hop': ['juicy the notorious big', 'nuthin but a g thang dr dre', 'ms jackson outkast', 'lose yourself eminem', 'california love 2pac', 'it was a good day ice cube', 'alright kendrick lamar', 'sicko mode travis scott', 'shook ones part ii mobb deep', 'ny state of mind nas', 'dear mama 2pac', 'still dre dr dre snoop dogg', 'humble kendrick lamar', 'gods plan drake', '99 problems jay-z', 'passin me by the pharcyde'],
  'Country': ['friends in low places garth brooks', 'jolene dolly parton', 'ring of fire johnny cash', 'take me home country roads john denver', 'before he cheats carrie underwood', 'cruise florida georgia line', 'need you now lady antebellum', 'tennessee whiskey chris stapleton', 'wagon wheel darius rucker', 'the gambler kenny rogers', 'amarillo by morning george strait', 'chicken fried zac brown band', 'body like a back road sam hunt', 'mama tried merle haggard', 'coal miners daughter loretta lynn', 'dirt road anthem jason aldean'],
  'Jazz': ['take five dave brubeck', 'so what miles davis', 'my favorite things john coltrane', 'feeling good nina simone', 'fly me to the moon frank sinatra', 'what a wonderful world louis armstrong', 'take the a train duke ellington', 'summertime ella fitzgerald', 'blue in green miles davis', 'sing sing sing benny goodman', 'my funny valentine chet baker', 'cantaloupe island herbie hancock', 'birdland weather report', 'strange fruit billie holiday', 'in a sentimental mood duke ellington john coltrane', 'watermelon man herbie hancock'],
  'Punk': ['blitzkrieg bop ramones', 'anarchy in the uk sex pistols', 'london calling the clash', 'holiday in cambodia dead kennedys', 'basket case green day', 'ever fallen in love buzzcocks', 'search and destroy the stooges', 'rise above black flag', 'i wanna be sedated ramones', 'god save the queen sex pistols', 'should i stay or should i go the clash', 'punk rock girl dead milkmen', 'los angeles x', 'sonic reducer dead boys', 'kick out the jams mc5', 'institutionalized suicidal tendencies'],
  'Disco': ['stayin alive bee gees', 'i will survive gloria gaynor', 'le freak chic', 'dancing queen abba', 'september earth wind and fire', 'funkytown lipps inc', 'dont stop til you get enough michael jackson', 'you should be dancing bee gees', 'good times chic', 'boogie wonderland earth wind and fire', 'im coming out diana ross', 'night fever bee gees', 'disco inferno the trammps', 'got to be real cheryl lynn', 'best of my love the emotions', 'knock on wood amii stewart'],
  'R&B': ['no diggity blackstreet', 'lets stay together al green', 'adorn miguel', 'untitled how does it feel dangelo', 'my boo usher alicia keys', 'say my name destinys child', 'best part daniel caesar', 'kiss it better rihanna', 'if i aint got you alicia keys', 'ordinary people john legend', 'weak swv', 'pony ginuwine', 'ex factor lauryn hill', 'end of the road boyz ii men', 'my girl the temptations', 'lets get it on marvin gaye'],
  'Indie': ['do i wanna know arctic monkeys', 'take me out franz ferdinand', 'dog days are over florence and the machine', 'electric feel mgmt', 'skinny love bon iver', 'myth beach house', 'the less i know the better tame impala', 'lisztomania phoenix', 'mr brightside the killers', 'wake up arcade fire', '1901 phoenix', 'young folks peter bjorn and john', 'kids mgmt', 'float on modest mouse', 'home edward sharpe', 'pumped up kicks foster the people'],
  'Metal': ['master of puppets metallica', 'paranoid black sabbath', 'ace of spades motorhead', 'run to the hills iron maiden', 'chop suey system of a down', 'walk pantera', 'enter sandman metallica', 'holy diver dio', 'crazy train ozzy osbourne', 'raining blood slayer', 'hallowed be thy name iron maiden', 'symphony of destruction megadeth', 'du hast rammstein', 'painkiller judas priest', 'one metallica', 'cowboys from hell pantera'],
  'Pop-punk': ['all the small things blink-182', 'sk8er boi avril lavigne', 'basket case green day', 'sugar were goin down fall out boy', 'ocean avenue yellowcard', 'misery business paramore', 'dammit blink-182', 'american idiot green day', 'first date blink-182', 'my friends over you new found glory', 'fat lip sum 41', 'the anthem good charlotte', 'check yes juliet we the kings', 'dear maria count me in all time low', 'still into you paramore', 'welcome to paradise green day'],
  'K-pop': ['dynamite bts', 'gangnam style psy', 'how you like that blackpink', 'ddu-du ddu-du blackpink', 'butter bts', 'fancy twice', 'gee girls generation', 'growl exo', 'kill this love blackpink', 'boy with luv bts', 'i am the best 2ne1', 'sorry sorry super junior', 'red flavor red velvet', 'love scenario ikon', 'next level aespa', 'super shy newjeans'],
  'Classical': ['clair de lune debussy', 'moonlight sonata beethoven', 'the four seasons spring vivaldi', 'canon in d pachelbel', 'nocturne op 9 no 2 chopin', 'ride of the valkyries wagner', 'symphony no 5 beethoven', 'gymnopedie no 1 satie', 'eine kleine nachtmusik mozart', 'fur elise beethoven', 'bolero ravel', 'the blue danube strauss', 'ode to joy beethoven', 'swan lake tchaikovsky', 'lacrimosa mozart', 'rhapsody in blue gershwin'],
  'Folk': ['the times they are a changin bob dylan', 'big yellow taxi joni mitchell', 'the sound of silence simon and garfunkel', 'this land is your land woody guthrie', 'ho hey the lumineers', 'i will wait mumford and sons', 'landslide fleetwood mac', 'rivers and roads the head and the heart', 'blowin in the wind bob dylan', 'if i had a hammer pete seeger', 'suzanne leonard cohen', 'both sides now joni mitchell', 'the boxer simon and garfunkel', 'wagon wheel old crow medicine show', 'stubborn love the lumineers', 'follow the sun xavier rudd'],
  'Electronic': ['one more time daft punk', 'strobe deadmau5', 'levels avicii', 'midnight city m83', 'galvanize chemical brothers', 'firestarter the prodigy', 'opus eric prydz', 'innerbloom rufus du sol', 'around the world daft punk', 'windowlicker aphex twin', 'right here right now fatboy slim', 'breathe the prodigy', 'satisfaction benny benassi', 'language porter robinson', 'shelter porter robinson madeon', 'faded alan walker'],
  'Reggae': ['no woman no cry bob marley', 'three little birds bob marley', 'red red wine ub40', 'bam bam sister nancy', 'israelites desmond dekker', 'pressure drop toots and the maytals', 'welcome to jamrock damian marley', 'temperature sean paul', 'could you be loved bob marley', 'the harder they come jimmy cliff', 'many rivers to cross jimmy cliff', '54-46 was my number toots and the maytals', 'night nurse gregory isaacs', 'here i come barrington levy', 'murder she wrote chaka demus and pliers', 'champion buju banton'],
  'Latin': ['despacito luis fonsi', 'la bamba ritchie valens', 'livin la vida loca ricky martin', 'danza kuduro don omar', 'bailando enrique iglesias', 'vivir mi vida marc anthony', 'gasolina daddy yankee', 'oye como va santana', 'suavemente elvis crespo', 'la tortura shakira', 'me gustas tu manu chao', 'burbujas de amor juan luis guerra', 'el cuarto de tula buena vista social club', 'pedro navaja ruben blades', 'la gota fria carlos vives', 'smooth santana rob thomas'],
  'Rock': ['bohemian rhapsody queen', 'back in black acdc', 'sweet child o mine guns n roses', 'smells like teen spirit nirvana', 'satisfaction the rolling stones', 'hotel california eagles', 'born to run bruce springsteen', 'wont get fooled again the who', 'stairway to heaven led zeppelin', 'free bird lynyrd skynyrd', 'dream on aerosmith', 'baba oriley the who', 'more than a feeling boston', 'tom sawyer rush', 'barracuda heart', 'you shook me all night long acdc'],
  'Pop': ['billie jean michael jackson', 'shake it off taylor swift', 'blinding lights the weeknd', 'firework katy perry', 'call me maybe carly rae jepsen', 'as it was harry styles', 'rolling in the deep adele', 'cant stop the feeling justin timberlake', 'like a prayer madonna', 'dancing queen abba', 'i want it that way backstreet boys', 'levitating dua lipa', 'bad romance lady gaga', 'roar katy perry', 'sorry justin bieber', 'anti-hero taylor swift'],
};
// Categories that need more than a good search query: filter results / dig past the hits.
const BOT_PICKY = {
  'Songs under 2 minutes': { filter: (t) => t.durationMs && t.durationMs < 120000 },
  'One-word title': { filter: (t) => !/\s/.test((t.name || '').trim()) },
  'Hidden gem (under 1M plays)': { mode: 'deep' },
};
// Free-typed category → closest seed list (checked before genre rules).
const BOT_PROMPT_RULES = [
  [/karaoke/, 'Karaoke banger'],
  [/instrumental|no (vocals|lyrics)/, 'Instrumentals'],
  [/\bcovers?\b/, 'Covers'],
  [/\bcry\b|\bsad\b|tear.?jerker|heartbreak/, 'Songs to cry to'],
  [/movie|film|soundtrack|cinematic/, 'Movie soundtrack'],
  [/road.?trip|driving/, 'Road trip'],
  [/duet|collab|featuring/, 'Best duet or collab'],
  [/workout|gym|pump|hype|adrenaline/, 'Pump me up'],
  [/guilty pleasure/, 'Guilty pleasures'],
  [/high school|throwback|nostalgi/, 'Song you loved in high school'],
  [/another language|foreign|non.?english/, 'Song in another language'],
  [/earworm|catchy|stuck in (my|your) head/, 'Earworms'],
  [/banger|club|party|dance.?floor/, 'Peak-hour banger'],
  [/chill|mellow|relax|cool.?down|wind.?down/, 'Cooldown'],
  [/late.?night|2 ?am|after.?hours/, 'After-hours (2am)'],
  [/opener|warm.?up/, 'Warm-up opener'],
  [/closer|closing|last song|send.?off/, 'Set closer'],
  [/short|under 2/, 'Songs under 2 minutes'],
  [/one.?word/, 'One-word title'],
  [/hidden gem|deep cut|obscure|underrated/, 'Hidden gem (under 1M plays)'],
];
// Free-typed genre words → [regex, spotify genre: filter, seed-list key]. Seeds beat the
// genre: filter (which is flaky on track search); order matters: pop punk before punk, k-pop before pop.
const BOT_GENRE_RULES = [
  [/pop.?punk/, 'pop punk', 'Pop-punk'], [/k.?pop/, 'k-pop', 'K-pop'], [/hip.?hop|\brap\b/, 'hip-hop', 'Hip-hop'],
  [/r&b|\brnb\b|\bsoul\b/, 'r&b', 'R&B'], [/electro|\bedm\b|\bhouse\b|techno/, 'electronic', 'Electronic'],
  [/country/, 'country', 'Country'], [/jazz/, 'jazz', 'Jazz'], [/punk/, 'punk', 'Punk'], [/disco/, 'disco', 'Disco'],
  [/indie/, 'indie', 'Indie'], [/metal/, 'metal', 'Metal'], [/classical/, 'classical', 'Classical'], [/\bfolk\b/, 'folk', 'Folk'],
  [/reggae/, 'reggae', 'Reggae'], [/latin/, 'latin', 'Latin'], [/\brock\b/, 'rock', 'Rock'], [/\bpop\b/, 'pop', 'Pop'],
  [/blues/, 'blues'], [/funk/, 'funk'],
];

// Returns a prioritized list of search steps {q, mode: top|any|deep, filter?} for a category.
function botQueriesFor(cat) {
  const c = (cat || '').trim(), lc = c.toLowerCase();
  const seeds = (key, extra) => shuffleArr(BOT_SEEDS[key]).map((q) => ({ q, mode: 'top', ...(BOT_PICKY[key] || {}), ...(extra || {}) }));

  // Decade + genre signals combine: "90s rap" → hip-hop seeds verified against 1990-1999.
  const dec = lc.match(/\b(?:19|20)?(\d)0'?s\b/);
  const named = [[/sixties/, 1960], [/seventies/, 1970], [/eighties/, 1980], [/nineties/, 1990]].find(([re]) => re.test(lc));
  let from = null;
  if (dec) { const d = +dec[1] * 10; from = d >= 30 ? 1900 + d : 2000 + d; }
  else if (named) from = named[1];
  const genreRule = BOT_GENRE_RULES.find(([re]) => re.test(lc));
  const g = genreRule && genreRule[1], gSeeds = genreRule && genreRule[2];
  const inDecade = (t) => t.year && t.year >= from && t.year < from + 10;
  const yearTail = from == null ? [] : shuffleArr(BOT_WORDS).map((w) => ({ q: `${w} year:${from}-${from + 9}`, mode: 'any' }));

  // "Mixes well after last winner" — actually look at what just won.
  if (lc.includes('mixes well')) {
    const last = state && state.history && state.history[state.history.length - 1];
    const artist = last && last.track && last.track.artists ? last.track.artists.split(',')[0].trim() : '';
    return (artist ? [{ q: artist, mode: 'any' }] : []).concat(seeds('Build the energy'));
  }
  // Decades sample the whole catalog first (year: filter + random word = endless
  // variety); curated seeds are the backstop. Other categories stay seeds-first.
  if (BOT_SEEDS[c]) return from != null ? yearTail.slice(0, 6).concat(seeds(c)) : seeds(c);
  if (from != null && gSeeds) return seeds(gSeeds, { filter: inDecade }).concat(yearTail);
  if (from != null && g) return shuffleArr(BOT_WORDS).map((w) => ({ q: `${w} genre:"${g}" year:${from}-${from + 9}`, mode: 'any' })).concat(yearTail);
  if (from != null) return yearTail;

  for (const [re, key] of BOT_PROMPT_RULES) if (re.test(lc)) return seeds(key);
  if (gSeeds) return seeds(gSeeds);
  if (g) return shuffleArr(BOT_WORDS).map((w) => ({ q: `${w} genre:"${g}"`, mode: 'any' })).concat({ q: `genre:"${g}"`, mode: 'any' });

  // Last resort: search the category text itself, minus filler words.
  const stripped = lc.replace(/\b(best|worst|favorite|favourite|song|songs|track|tracks|tune|tunes|a|an|the|of|all|time|your|my|most|that|to|for|with|ever|about)\b/g, ' ').replace(/\s+/g, ' ').trim();
  const plan = [];
  if (stripped && stripped !== lc) plan.push({ q: stripped, mode: 'any' });
  plan.push({ q: c, mode: 'any' });
  return plan;
}

// Not real submissions: karaoke/tribute covers, white noise, kids novelty, etc.
const BOT_JUNK = /karaoke|tribute|made famous|in the style of|cover (by|ver)|string quartet|orchestral ver|piano (version|cover)|english ver|acoustic ver|\binst\b|white noise|rain sounds|nature sounds|sleep (sounds|music|aid|baby)|asmr|lullab|meditat|music box|8.?bit|nursery|kidz|cocomelon|super simple/i;

// Runs the plan against /api/search until a fresh track turns up. null = nothing found.
// `used` holds ids AND normalized name|artist keys, so remasters of a taken song don't sneak in.
async function botPickTrack(category, used) {
  const nameKey = (t) => (t.name || '').toLowerCase().replace(/\s*[([-].*$/, '').trim() + '|' + (t.artists || '').toLowerCase();
  for (const step of botQueriesFor(category).slice(0, 12)) {
    try {
      const r = await api('/api/search?q=' + encodeURIComponent(step.q));
      let cands = (r.tracks || []).filter((t) => t.id && !BOT_JUNK.test(`${t.name} ${t.artists} ${t.album}`));
      if (step.filter) cands = cands.filter(step.filter);
      let t = null;
      if (step.mode === 'top') {
        // Seed queries: the top hit IS the song. If a previous bot already took it,
        // jump to the next seed rather than sliding into covers/remasters of it.
        t = cands[0];
        if (t && (used.has(t.id) || used.has(nameKey(t)))) t = null;
      } else {
        cands = cands.filter((x) => !used.has(x.id) && !used.has(nameKey(x)));
        t = step.mode === 'deep' ? cands[cands.length - 1] : cands[Math.floor(Math.random() * Math.min(8, cands.length))];
      }
      if (t) { used.add(t.id); used.add(nameKey(t)); return t; }
    } catch (_) { /* search hiccup or dud query — try the next step */ }
  }
  return null;
}

// ---------------- bot autopilot (bots play their whole turn unprompted) ----------------
// Runs from the host's browser on every poll tick. Bots pick a category when the round is
// theirs, submit an on-category song, and vote, with no cueing. If a bot wins, the game
// moves on to its pick a few seconds after the reveal. Bots pause while the host closes the tab.
const ALL_CATS = [...PROMPTS, ...GENRES, ...DJFLOW];
const autopilot = { busy: false, round: 0, used: new Set(), revealSeen: 0, nextFired: false };

async function botAutopilot(s) {
  if (autopilot.busy || !s || !s.you || !s.you.isHost) return;
  const imp = store.impersonate;
  // Hands off any bot the host is currently playing as.
  const bots = testStore.ids.filter((b) => !imp || imp.id !== b.id);
  if (!bots.length) return;
  if (s.round !== autopilot.round) { autopilot.round = s.round; autopilot.used.clear(); autopilot.revealSeen = 0; autopilot.nextFired = false; }
  const flag = (b, key) => (s.players.find((p) => p.name === b.name) || {})[key];
  autopilot.busy = true;
  try {
    if (s.phase === 'picking') {
      const picker = bots.find((b) => b.name === s.pickerLabel);
      if (picker) {
        const cat = ALL_CATS[Math.floor(Math.random() * ALL_CATS.length)];
        await api('/api/category', { playerId: picker.id, category: cat });
        toast(`🤖 ${picker.name} picked: ${cat}`, false);
        await poll();
      }
    } else if (s.phase === 'submitting') {
      // Don't let a bot duplicate the host's own pick.
      if (s.yourSubmission && s.yourSubmission.id) autopilot.used.add(s.yourSubmission.id);
      const pending = bots.filter((b) => flag(b, 'submitted') === false);
      for (const b of pending) {
        const track = serverSearch ? await botPickTrack(s.category, autopilot.used) : null;
        await api('/api/submit', { playerId: b.id, track: track || { manual: 'Mystery track from ' + b.name } });
      }
      if (pending.length) await poll();
    } else if (s.phase === 'voting') {
      const pending = bots.filter((b) => flag(b, 'voted') === false);
      for (const b of pending) {
        for (const sid of shuffleArr((s.songs || []).map((x) => x.sid))) {
          try { await api('/api/vote', { playerId: b.id, sid }); break; } catch (_) { /* own song — try next */ }
        }
      }
      if (pending.length) await poll();
    } else if (s.phase === 'results' && s.revealed && s.winnerName && bots.some((b) => b.name === s.winnerName)) {
      // A bot won: give the reveal a moment on screen, then move the game along for it.
      if (!autopilot.revealSeen) autopilot.revealSeen = Date.now();
      else if (!autopilot.nextFired && Date.now() - autopilot.revealSeen > 6000) {
        autopilot.nextFired = true;
        await api('/api/next', { playerId: store.playerId });
        await poll();
      }
    }
  } catch (_) { /* transient error: server flags still show the action pending, next tick retries */ }
  autopilot.busy = false;
}

function renderTestTools(s) {
  const el = $('#test-tools');
  if (!el) return;
  if (!s.you || !s.you.isHost) { el.innerHTML = ''; return; }
  const bots = testStore.ids;
  const imp = store.impersonate;
  el.innerHTML = `
    <div class="tt-row">
      <button id="tt-add" class="btn small ghost">➕ Add test players</button>
      <input id="tt-count" class="tt-count" type="number" min="1" max="30" value="1" aria-label="How many test players to add">
    </div>
    ${bots.map((b) => `
      <div class="tt-row">
        <span>${imp && imp.id === b.id ? '🎭 ' : ''}${esc(b.name)}</span>
        <button class="btn small ${imp && imp.id === b.id ? 'primary' : 'ghost'} tt-imp" data-id="${esc(b.id)}" data-name="${esc(b.name)}">
          ${imp && imp.id === b.id ? 'Playing ✓' : 'Play as'}
        </button>
      </div>`).join('')}
    ${bots.length ? '<p class="muted tt-hint">🤖 Autopilot: bots pick categories, submit on-category songs and vote on their own.</p>' : ''}
    ${bots.length ? '<button id="tt-clear" class="btn small ghost">🧹 Remove tests</button>' : ''}`;

  el.querySelectorAll('.tt-imp').forEach((b) => {
    b.onclick = () => {
      const already = store.impersonate && store.impersonate.id === b.dataset.id;
      setImpersonate(already ? null : { id: b.dataset.id, name: b.dataset.name });
      toast(already ? 'Back to yourself ✓' : `Now playing as ${b.dataset.name} 🎭`, false);
    };
  });

  $('#tt-add').onclick = async () => {
    const n = Math.max(1, Math.min(30, Math.round(+$('#tt-count').value) || 1));
    const added = [];
    try {
      for (let i = 0; i < n; i++) {
        const name = 'Test ' + (bots.length + added.length + 1);
        const j = await api('/api/join', { name, bot: true }); // bot votes score 250 vs 500
        added.push({ id: j.playerId, name });
      }
    } catch (e) { toast(e.message); }
    if (added.length) {
      testStore.ids = [...bots, ...added];
      toast(added.length === 1 ? `${added[0].name} joined 🎭` : `${added.length} test players joined 🎭`, false);
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
    return `<li><span class="muted">R${h.round} · ${esc(h.category)}:</span> 🏆 ${t}${h.by ? ` <span class="muted">(${esc(h.by)})</span>` : ''} (${h.points != null ? h.points.toLocaleString() + ' pts · ' : ''}${h.votes} vote${h.votes === 1 ? '' : 's'}${h.tie ? ' · 🎲 tie-break' : ''})</li>`;
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
    // Snippet start = wherever they left the player (play or drag); untouched = auto.
    const chosen = { ...staged, startSec: ypPosMs != null ? Math.floor(ypPosMs / 1000) : null };
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
  ypCtl = null; ypPosMs = null;
  yp.innerHTML = `
    <div class="your-pick-banner">🎵 Selected: <b>${trackLabel(t)}</b> <span class="muted">— hit Submit below to lock it in</span>
      ${t.id ? `
        <div id="yp-embed"></div>
        <span class="muted tiny-note">Snippet start: <b id="yp-start">auto (~${fmtTime(snippetStart(t))})</b> — play or drag the player to the moment you want; Submit locks that spot in.</span>
        <div class="row snippet-row">
          <button id="yp-preview" class="btn small ghost">▶ Preview my ${SNIP_SEC}s snippet</button>
        </div>` : ''}
    </div>`;
  if (t.id) setupYourPickPlayer(t);
  const btn = $('#submit-song-btn');
  if (btn) {
    btn.disabled = false;
    btn.textContent = state && state.yourSubmission ? 'Update my song 🎵' : 'Submit song 🎵';
  }
}

// Your-pick player: an embed of the submitter's own song. Wherever they play or drag
// it to IS the snippet start — no typing. Submit (or 📍) locks the current spot in.
let ypCtl = null;
let ypPosMs = null; // last position (ms) the player was left at; null = never touched → auto
let ypPaused = false; // freshest paused state from the your-pick embed
function setupYourPickPlayer(t) {
  const slot = $('#yp-embed');
  ensureEmbedApi((embApi) => {
    if (!embApi || !slot || !document.contains(slot)) return;
    const holder = document.createElement('div');
    slot.appendChild(holder);
    embApi.createController(holder, { uri: 'spotify:track:' + t.id, height: 80 }, (ctl) => {
      ypCtl = ctl;
      ctl.addListener('playback_update', (e) => {
        if (!e || !e.data) return;
        ypPaused = !!e.data.isPaused;
        const ms = e.data.position ?? e.data.progress ?? 0;
        if (ms <= 0) return;
        ypPosMs = ms;
        const el = $('#yp-start');
        if (el) el.textContent = fmtTime(Math.floor(ms / 1000));
      });
      const prev = $('#yp-preview');
      if (prev) prev.onclick = () => {
        const start = ypPosMs != null ? Math.floor(ypPosMs / 1000) : snippetStart(t);
        ctl.seek(start);
        ctl.play();
        // Correct only if the embed audibly started from 0 (a blind re-seek restarts
        // playback), and if the seek knocks the stream out, kick it back on.
        if (start > 4) setTimeout(() => {
          if (ypPosMs != null && ypPosMs < 2000) {
            ctl.seek(start);
            setTimeout(() => { if (ypPaused) ctl.play(); }, 800);
          }
        }, 1100);
        clearTimeout(setupYourPickPlayer._t);
        // After the preview window, park the player back on the chosen spot.
        setupYourPickPlayer._t = setTimeout(() => { ctl.pause(); ctl.seek(start); ypPosMs = start * 1000; }, SNIP_SEC * 1000 + 1000);
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
  mix.stop = true; // kill any listening party still running from a previous round
  root().innerHTML = `
    <div class="card">
      <div class="cat-banner">Category: <b>${esc(s.category)}</b></div>
      <h2>Vote for the best 🗳️</h2>
      <p class="muted" id="vote-progress"></p>
      <p class="muted">Votes are anonymous. You can't vote for your own.</p>
      <div class="row center-row">
        <button id="listen-play" class="btn primary">▶ Play the choices (${SNIP_SEC}s each)</button>
        <button id="listen-stop" class="btn ghost hidden">■ Stop</button>
      </div>
      <div id="listen-status" class="cat-banner hidden"></div>
      <div id="listen-progress" class="snip-progress hidden"><div class="prog-track"><div class="prog-fill" id="listen-fill"></div></div><span class="muted" id="listen-time"></span></div>
      <div id="ballot">
        ${s.songs.map((song) => `
          <div class="song-card" id="song-${song.sid}">
            ${song.track.id
              ? `<div class="embed-slot" data-sid="${esc(song.sid)}" data-tid="${esc(song.track.id)}"></div>`
              : `<div class="manual-track">🎵 ${trackLabel(song.track)}</div>`}
            <div class="song-actions">
              ${song.track.id ? `<button class="btn small ghost snip-btn" data-sid="${esc(song.sid)}" data-start="${snippetStart(song.track)}">▶ ${SNIP_SEC}s snippet</button>` : ''}
              <button class="btn small vote-btn" data-sid="${esc(song.sid)}">Vote</button>
            </div>
          </div>`).join('')}
      </div>
      ${s.you.isHost ? '<div id="vote-board"></div>' : ''}
    </div>`;
  const lp = $('#listen-play');
  const startParty = () => playBallot({
    playBtn: lp,
    stopBtn: $('#listen-stop'),
    status: (h) => { const el = $('#listen-status'); if (el) { el.classList.remove('hidden'); el.innerHTML = h; } },
    highlight: (it) => {
      document.querySelectorAll('#ballot .song-card').forEach((c) => c.classList.remove('now'));
      if (it) { const c = $('#song-' + it.sid); if (c) c.classList.add('now'); }
    },
    progress: snipProgress('listen'),
    doneMsg: "That's the ballot — cast your votes! 🗳️",
  });
  lp.onclick = startParty;
  $('#listen-stop').onclick = stopSet;
  // The listening party starts itself on every device, not just the host's — but only
  // in the tab the player is actually looking at, and only once per round.
  // (If the browser blocks the auto-start, the Play button is right there.)
  voteParty.round = s.round; voteParty.played = false; voteParty.start = startParty;
  if (!s.yourVote) {
    let tries = 0;
    const kick = () => {
      if (!state || state.phase !== 'voting' || state.yourVote) return; // round moved on
      if (document.hidden) return; // hidden tab: visibilitychange starts it if they come back
      if (mix.running) { if (++tries < 5) setTimeout(kick, 800); return; }
      voteParty.played = true;
      startParty();
    };
    setTimeout(kick, 1200);
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
  wireSnippets();
  updateInPlace(s);
}

// Turn embed slots into controllable players; snippet buttons seek to the start
// point and auto-pause after 30 seconds. Falls back to plain embeds if the
// iFrame API can't load (snippets then use Spotify's own preview clip).
let embedState = {}; // sid -> {pos, paused, at}: freshest playback report from that card's embed
let ballotCtls = {}; // sid -> embed controller for this screen's cards (the party plays through these)
let ballotDead = false; // iframe API blocked → plain embeds, no programmatic playback
function wireSnippets() {
  embedState = {};
  ballotCtls = {};
  ballotDead = false;
  const slots = [...root().querySelectorAll('.embed-slot')];
  if (!slots.length) return;
  const controllers = {};
  let ready = false;

  const fallback = () => {
    // Only touch the slots captured by THIS call — a stale timer from a previous
    // screen must not convert or strip controls on the current one.
    ballotDead = true;
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
        ballotCtls[sid] = c;
        c.addListener('playback_update', (e) => {
          if (!e || !e.data) return;
          const ms = e.data.position ?? e.data.progress ?? 0;
          embedState[sid] = { pos: ms, paused: !!e.data.isPaused, at: Date.now() };
        });
      });
    });
  });
  setTimeout(() => { if (!ready) fallback(); }, 4000); // script hung / blocked

  let active = null, stopTimer = null;
  root().querySelectorAll('.snip-btn').forEach((b) => {
    b.onclick = async () => {
      // Manual listening takes over from the auto-party (and its final pause).
      if (mix.running) { stopSet(); await new Promise((r) => setTimeout(r, 400)); }
      if (active) { active.pause(); active = null; }
      clearTimeout(stopTimer);
      // Preview clip first — the only audio that reliably plays for logged-in listeners.
      const song = (state && state.songs || []).find((x) => x.sid === b.dataset.sid);
      if (song && song.track.previewUrl) {
        if (await playPreviewSnippet(song.track.previewUrl, {})) return;
      }
      const c = controllers[b.dataset.sid];
      if (!c) return toast('Player still loading — try again in a second', false);
      stopPreview();
      active = c;
      const start = +b.dataset.start || 0;
      c.seek(start);
      ensurePlaying(c, b.dataset.sid, start, () => active !== c);
      stopTimer = setTimeout(() => { if (active === c) c.pause(); }, SNIP_SEC * 1000 + 1000);
    };
  });
}

// ---------------- preview snippets ----------------
// Plain 30s clips (attached server-side per submission) played through our own
// <audio>. Unlike logged-in Spotify embeds — whose full-track DRM streams silently
// lose audio while the UI keeps progressing — a plain clip plays the same for
// everyone, so it's the first choice for all programmatic playback off the SDK.
const snd = { el: null, token: 0 };
function stopPreview() {
  snd.token++;
  if (snd.el) { try { snd.el.pause(); } catch (_) {} }
}

// iOS Safari only plays audio started by a user gesture — timers and async chains
// (like the auto-party) are blocked cold. But once a gesture-initiated play has
// "blessed" an element, iOS lets that SAME element play programmatically forever.
// So: on the player's first tap anywhere (join, pick, submit — long before voting),
// run a instant silent clip through our shared player to unlock it.
const SILENT_WAV = 'data:audio/wav;base64,UklGRigAAABXQVZFZm10IBAAAAABAAEARKwAAIhYAQACABAAZGF0YQQAAAAAAA==';
function unlockAudio() {
  if (unlockAudio.done) return;
  const el = snd.el || (snd.el = new Audio());
  if (!el.paused) { unlockAudio.done = true; return; } // already audibly in use — blessed
  el.muted = true;
  el.src = SILENT_WAV;
  const p = el.play();
  // The promise can resolve AFTER real playback has taken over the shared element
  // (mobile resolves late) — only ever pause/unmute our own silent clip.
  const own = () => (el.src || '').startsWith('data:');
  if (p && p.then) {
    p.then(() => { unlockAudio.done = true; if (own()) { el.pause(); el.muted = false; } })
      .catch(() => { if (own()) el.muted = false; });
  }
}
['touchend', 'mousedown', 'keydown', 'click'].forEach((ev) => document.addEventListener(ev, unlockAudio, true));
// Plays up to SNIP_SEC of the clip with soft edges. Resolves true if audio actually
// ran (currentTime moved), false if it never started (blocked / dead link).
function playPreviewSnippet(url, { cancelled = () => false, onTick = null } = {}) {
  return new Promise((resolve) => {
    stopPreview();
    const my = ++snd.token;
    const el = snd.el || (snd.el = new Audio());
    el.muted = false; // the unlock ritual may have left it muted
    el.src = url;
    el.volume = 0; // no-op on iOS (volume is hardware-only there) — plays at full volume, fades elsewhere
    const t0 = Date.now();
    let started = false;
    const done = (ok) => { clearInterval(iv); if (snd.token === my) { try { el.pause(); } catch (_) {} } resolve(ok); };
    const iv = setInterval(() => {
      if (snd.token !== my || cancelled()) return done(started);
      const ms = Date.now() - t0;
      if (onTick) onTick(Math.min(ms, SNIP_SEC * 1000), SNIP_SEC * 1000);
      if (!started && el.currentTime > 0.05) started = true;
      const FADE = 400;
      el.volume = Math.max(0, Math.min(1, Math.min(ms / FADE, (SNIP_SEC * 1000 - ms) / FADE)));
      if (ms >= SNIP_SEC * 1000 || (started && el.ended)) return done(true);
      if (!started && ms > 3000) return done(false); // never started — blocked or unreachable
    }, 100);
    const p = el.play();
    if (p && p.catch) p.catch(() => done(false));
  });
}

// Start a card's embed at `start` sec and confirm audio is actually moving.
// Hard-won timing rules (logged-in full-track embeds are DRM streams and fragile):
// 1. "Playing" means the reported position ADVANCES — a single un-paused report can
//    just be the embed announcing intent while it still boots.
// 2. NEVER seek while the embed is booting — it kills the pending play. Correct the
//    position only after playback has settled, then verify the seek survived.
async function ensurePlaying(ctl, sid, start, cancelled) {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  for (let attempt = 0; attempt < 3; attempt++) {
    if (cancelled()) return false;
    const mark = Date.now();
    ctl.play();
    let last = -1, moving = false;
    while (Date.now() - mark < 3500) {
      if (cancelled()) return false;
      const st = embedState[sid];
      if (st && st.at >= mark && !st.paused) {
        if (last >= 0 && st.pos > last + 80) { moving = true; break; }
        last = st.pos;
      }
      await sleep(150);
    }
    if (!moving) continue; // iframe wasn't listening yet — try again
    if (start > 4 && last < 2500) {
      // Started near 0 instead of the chosen spot: settle, correct once, verify.
      await sleep(700);
      if (cancelled()) return true;
      const st = embedState[sid];
      if (st && !st.paused && st.pos < 4000) {
        ctl.seek(start);
        await sleep(700);
        const st2 = embedState[sid];
        if (st2 && st2.paused && !cancelled()) ctl.play(); // seek knocked it out — kick it back on
      }
    }
    return true;
  }
  return false;
}

// Voting listening party: plays each ballot card's own embed in order — no SDK,
// no hidden player, no Spotify Connect takeover. The active card lights up and
// its embed visibly plays, identically on every player's device. If something
// else keeps stealing the account's stream (Spotify allows ONE stream per
// account — another tab, the desktop app, a phone), we say so instead of
// ghosting through silent snippets.
async function playBallot(ui) {
  if (mix.running) return;
  const items = (state.songs || []).filter((x) => x.track.id);
  if (!items.length) return;
  mix.running = true; mix.stop = false; mix.kind = 'ballot';
  ui.playBtn.classList.add('hidden');
  ui.stopBtn.classList.remove('hidden');
  let current = null, interrupted = false, started = 0, sdkFails = 0;

  // Connected host with Premium: the Web Playback SDK is the proven game-day player
  // (full tracks over Spotify Connect, no embed/DRM fragility). Everyone else: embeds.
  let sdkOk = false;
  if (spotify.connected) {
    ui.status('Warming up the decks…');
    sdkOk = await Promise.race([
      initMixPlayer().catch(() => false),
      (async () => { while (!mix.stop) await waitMs(200); return false; })(),
    ]);
  }
  try {
    for (let i = 0; i < items.length; i++) {
      if (mix.stop || (!sdkOk && ballotDead)) break;
      const it = items[i];
      ui.highlight(it);
      ui.status(`Now playing ${i + 1}/${items.length}: <b>${trackLabel(it.track)}</b>`);

      if (sdkOk) {
        started++;
        const t0 = Date.now();
        const tick = setInterval(() => { if (ui.progress) ui.progress(Math.min(SNIP_SEC * 1000, Date.now() - t0), SNIP_SEC * 1000); }, 200);
        let err = false;
        try { await sdkPlaySnippet(it.track); sdkFails = 0; } catch (_) { err = true; } finally { clearInterval(tick); }
        if (err) {
          started--;
          resetMixPlayer();
          sdkOk = await initMixPlayer().catch(() => false); // stale device: one reconnect
          if (sdkOk && ++sdkFails >= 2) sdkOk = false; // keeps failing: clips take over
          i--; // replay this song on whichever player is now active
        }
        continue;
      }

      // Preview clip: reliable plain audio, same on every device.
      if (it.track.previewUrl) {
        const opts = { cancelled: () => mix.stop, onTick: (p, t) => { if (ui.progress) ui.progress(p, t); } };
        let ok = await playPreviewSnippet(it.track.previewUrl, opts);
        // First clip can lose the race with the mobile unlock ritual — try once more.
        if (!ok && !mix.stop) ok = await playPreviewSnippet(it.track.previewUrl, opts);
        if (ok) { started++; continue; }
        if (mix.stop) break;
        // clip blocked or dead — fall through to the embed
      }

      // Embed path: wait for this card's controller (they build asynchronously).
      for (let w = 0; w < 15 && !ballotCtls[it.sid] && !mix.stop && !ballotDead; w++) await waitMs(300);
      const ctl = ballotCtls[it.sid];
      if (!ctl || mix.stop) continue;
      const start = snippetStart(it.track);
      current = ctl;
      ctl.seek(start); // pre-seek is free: booting iframes just drop it
      const ok = await ensurePlaying(ctl, it.sid, start, () => mix.stop || current !== ctl);
      if (!ok) { if (mix.stop) break; continue; } // dead player: move on, don't burn 15s
      started++;
      const readyAt = Date.now();
      let resumes = 0;
      while (Date.now() - readyAt < SNIP_SEC * 1000 && !mix.stop) {
        await waitMs(200);
        if (ui.progress) ui.progress(Math.min(SNIP_SEC * 1000, Date.now() - readyAt), SNIP_SEC * 1000);
        const st = embedState[it.sid];
        if (st && st.paused && st.at > readyAt) {
          // Externally paused (stream stolen / embed hiccup): kick it back on, twice.
          if (resumes < 2) { resumes++; ctl.play(); await waitMs(1000); continue; }
          interrupted = true;
          break;
        }
      }
      if (current === ctl && !interrupted) ctl.pause();
      if (interrupted) break;
    }
    ui.status(mix.stop ? 'Stopped.'
      : interrupted ? '⚠️ Playback keeps getting cut — is Spotify playing in another tab, app, or device? Pause it there, then hit ▶ again.'
      : !started ? 'Auto-play was blocked here — tap ▶ Play the choices, or ▶ on any card.'
      : ui.doneMsg);
  } catch (e) {
    ui.status('Playback hiccup: ' + esc(e.message));
  } finally {
    mix.running = false;
    if (mix.player) mix.player.pause().catch(() => {});
    try { if (current && !interrupted) current.pause(); } catch (_) {}
    ui.highlight(null);
    if (ui.progress) ui.progress(-1, 0);
    ui.playBtn.classList.remove('hidden');
    ui.stopBtn.classList.add('hidden');
  }
}

// Hidden tabs must never hold the account's single Spotify stream — a background
// tab auto-playing is exactly what cuts off the tab the player is looking at.
const voteParty = { round: 0, played: false, start: null }; // this round's auto-party (one shot per tab)
document.addEventListener('visibilitychange', () => {
  if (document.hidden && mix.running && mix.kind === 'ballot') stopSet();
  else if (!document.hidden && state && state.phase === 'voting' && !state.yourVote
    && voteParty.start && !voteParty.played && !mix.running) {
    voteParty.played = true;
    setTimeout(voteParty.start, 600);
  }
});

function renderResults(s) {
  mix.stop = true; // voting's listening party ends with the round
  const sorted = s.songs.slice().sort((a, b) => b.points - a.points);
  root().innerHTML = `
    <div class="card">
      <div class="cat-banner">Category: <b>${esc(s.category)}</b></div>
      <h2>Results 🏁</h2>
      <p class="muted center">Every vote is worth <b>2,000 pts</b> (bot votes 250). Most points takes the round.</p>
      ${s.tieCount > 1 ? `<div class="cat-banner">🎲 <b>${s.tieCount}-way tie</b> at the top — winner drawn at random!</div>` : ''}
      ${s.youWon
        ? `<div class="win-banner">🏆 <b>You won this round!</b>${s.tieCount > 1 ? ' (won the random draw)' : ''}${s.revealed ? '' : ' Keep a poker face while they guess. 🤫'}</div>`
        : s.revealed && s.winnerName
          ? `<div class="win-banner">🏆 <b>${esc(s.winnerName)}</b> takes the round!${s.tieCount > 1 ? ' (random draw)' : ''}</div>`
          : `<div class="win-banner">🕵️ We have a winning song — but <b>whose is it?</b> Take your guesses!</div>`}
      ${s.you.isHost && !s.revealed ? '<p class="center"><button id="reveal-btn" class="btn primary">🎭 Reveal whose songs these are</button></p>' : ''}
      <div id="ballot">
        ${sorted.map((song) => `
          <div class="song-card ${song.winner ? 'winner' : ''}" id="rsong-${esc(song.sid)}">
            <div class="result-row">
              <span class="vote-count"><b class="pts-num" data-target="${song.points || 0}">0</b><span class="pts-label">pts</span></span>
              <div class="tmeta">
                ${song.winner ? '🏆 ' : ''}<b>${trackLabel(song.track)}</b>
                ${song.tied ? '<span class="chip tiny tie-chip">🎲 tied</span>' : ''}
                <span class="muted">${song.votes} vote${song.votes === 1 ? '' : 's'} · ${song.by ? `${esc(song.by)}'s pick` : 'whose pick…?'}${song.mine && s.revealed ? ' <span class="chip tiny">you</span>' : ''}</span>
              </div>
            </div>
            ${song.track.id ? `<div class="embed-slot" data-sid="${esc(song.sid)}" data-tid="${esc(song.track.id)}"></div>` : ''}
          </div>`).join('')}
      </div>
      ${s.revealed && s.scores && s.scores.length ? `
        <div class="standings"><span class="muted">Standings:</span> ${s.scores.map((r, i) =>
          `<span class="vb ${i === 0 ? 'in' : ''}">${i === 0 ? '👑 ' : ''}${esc(r.name)} <b>${r.points.toLocaleString()}</b></span>`).join('')}</div>` : ''}
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
  animatePoints(root()); // roll the totals up, last place first, winner lands last
  autoPlayWinner(s); // results should SOUND like results
}

// The winning song starts playing by itself the moment results land — once per
// round, only in a visible tab. Clip first (reliable everywhere), embed fallback.
const winnerPlay = { round: 0 };
async function autoPlayWinner(s) {
  const win = (s.songs || []).find((x) => x.winner);
  if (!win || !win.track.id || winnerPlay.round === s.round || document.hidden) return;
  winnerPlay.round = s.round;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const onResults = () => state && state.phase === 'results' && state.round === s.round;
  const mark = (on) => { const c = $('#rsong-' + win.sid); if (c) c.classList.toggle('now', on); };
  mark(true);
  let ok = false;
  if (win.track.previewUrl) ok = await playPreviewSnippet(win.track.previewUrl, { cancelled: () => !onResults() });
  if (!ok && onResults()) {
    for (let w = 0; w < 10 && !ballotCtls[win.sid] && onResults(); w++) await sleep(300);
    const ctl = ballotCtls[win.sid];
    if (ctl && onResults()) {
      const start = snippetStart(win.track);
      ctl.seek(start);
      if (await ensurePlaying(ctl, win.sid, start, () => !onResults())) {
        await sleep(SNIP_SEC * 1000);
        ctl.pause();
      }
    }
  }
  mark(false);
}

// Count-up drama for point totals: lowest cards tick up first, the winner lands last
// and pops. Re-runs whenever the screen renders (fresh results and again on reveal).
function animatePoints(scope) {
  const els = [...scope.querySelectorAll('.pts-num')];
  els.forEach((el, i) => {
    const target = +el.dataset.target || 0;
    const delay = (els.length - 1 - i) * 300; // DOM order = highest first, so winner waits longest
    const dur = 1100;
    const land = () => {
      el.textContent = target.toLocaleString();
      const card = el.closest('.song-card.winner, .lead-row.first');
      if (card) card.classList.add('pop');
    };
    const t0 = performance.now() + delay;
    const step = (now) => {
      if (!document.contains(el)) return;
      if (now < t0) return requestAnimationFrame(step);
      const k = Math.min(1, (now - t0) / dur);
      const eased = 1 - Math.pow(1 - k, 3);
      el.textContent = Math.round(target * eased).toLocaleString();
      if (k < 1) return requestAnimationFrame(step);
      land();
    };
    requestAnimationFrame(step);
    // Backgrounded tabs throttle animation frames — always land on the real total.
    setTimeout(() => { if (document.contains(el)) land(); }, delay + dur + 600);
  });
}

// ---------------- Final Mix (DJ set of round winners) ----------------
const mix = { running: false, stop: false, player: null, deviceId: null, embedCtl: null, embedHost: null };

function renderFinale(s) {
  mix.stop = true; // cancel any prior run's loop before rebuilding the screen
  const list = s.history;
  const playable = list.filter((h) => h.track.id).length;
  const champ = s.scores && s.scores.length ? s.scores[0] : null;
  root().innerHTML = `
    <div class="card">
      <h2>🎬 The Final Mix</h2>
      ${champ ? `<div class="win-banner">👑 <b>${esc(champ.name)}</b> wins the game with <b>${champ.points.toLocaleString()} pts</b>!</div>` : ''}
      ${s.scores && s.scores.length ? `
        <div class="leaderboard">
          ${s.scores.map((r, i) => `
            <div class="lead-row ${i === 0 ? 'first' : ''}">
              <span class="lead-rank">${i === 0 ? '👑' : i + 1}</span>
              <span class="lead-name">${esc(r.name)}${r.isBot ? ' <span class="chip tiny">bot</span>' : ''}</span>
              <span class="vote-count"><b class="pts-num" data-target="${r.points}">0</b><span class="pts-label">pts</span></span>
            </div>`).join('')}
        </div>` : ''}
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
  animatePoints(root());
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
  stopPreview();
  if (mix.player) mix.player.pause().catch(() => {});
  if (mix.embedCtl) mix.embedCtl.pause();
}

// Shared DJ engine: plays each item's snippet (SNIP_SEC) in order. ui supplies the
// screen-specific hooks (finale setlist vs. voting listening party).
async function playSet(items, ui) {
  if (mix.running) return;
  const playable = items.filter((it) => it.track.id);
  if (!playable.length) return toast('No Spotify tracks to play');
  mix.running = true; mix.stop = false; mix.kind = 'set';
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
        let played = false;
        if (sdkOk) {
          try { await sdkPlaySnippet(it.track); played = true; }
          catch (_) {
            // Spotify expires idle SDK devices (the /play then 404s) — reconnect once.
            resetMixPlayer();
            sdkOk = await initMixPlayer().catch(() => false);
            if (sdkOk) { try { await sdkPlaySnippet(it.track); played = true; } catch (_) { sdkOk = false; } }
          }
        }
        if (!played && !mix.stop) {
          if (!(it.track.previewUrl && await playPreviewSnippet(it.track.previewUrl, { cancelled: () => mix.stop }))) {
            await embedPlaySnippet(it.track, ui.embedSlot());
          }
        }
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
// Drops a dead SDK connection so initMixPlayer can build a fresh device.
function resetMixPlayer() {
  try { if (mix.player) mix.player.disconnect(); } catch (_) {}
  mix.player = null;
  mix.deviceId = null;
}
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
  await mix.player.setVolume(1).catch(() => {}); // a dropped ramp step must not leave the set inaudible
  await waitMs(Math.max(0, SNIP_SEC * 1000 - fadeIn - fadeOut));
  await rampVolume(1, 0, fadeOut);
  await playerApi('/pause?device_id=' + mix.deviceId);
}

// --- Fallback: one reusable embed player, hard cuts (previews if logged out) ---
function embedPlaySnippet(t, slot) {
  return new Promise((resolve) => {
    if (!slot || !document.contains(slot)) return resolve();
    waitMs(SNIP_SEC * 1000 + 9000).then(resolve); // blocked/hung embed must not stall the set (stops early on ■)
    slot.classList.remove('hidden');
    // The embed lives inside one screen's slot — if that screen was re-rendered, rebuild it.
    if (mix.embedHost && !document.contains(mix.embedHost)) {
      try { mix.embedCtl.destroy(); } catch (_) {}
      mix.embedCtl = null; mix.embedHost = null;
    }
    const go = (ctl) => {
      const start = snippetStart(t);
      const mark = Date.now();
      ctl.seek(start);
      ctl.play();
      // Iframes drop commands while booting: retry the play first, and only once
      // playback settles correct a wrong position — never seek mid-boot (it kills
      // the pending play), and if the seek knocks it out, kick it back on.
      setTimeout(() => {
        if (mix.stop) return;
        const st = mix.embedState;
        if (!st || st.at < mark) ctl.play();
        setTimeout(() => {
          if (mix.stop) return;
          const st2 = mix.embedState;
          if (start > 4 && st2 && !st2.paused && st2.pos < 2500) {
            ctl.seek(start);
            setTimeout(() => { const st3 = mix.embedState; if (!mix.stop && st3 && st3.paused) ctl.play(); }, 800);
          }
        }, 1000);
      }, 1200);
      waitMs(SNIP_SEC * 1000).then(() => { ctl.pause(); resolve(); });
    };
    if (mix.embedCtl) { mix.embedCtl.loadUri('spotify:track:' + t.id); setTimeout(() => go(mix.embedCtl), 600); return; }
    ensureEmbedApi((api) => {
      if (!api) { toast('Spotify player blocked — skipping playback'); return resolve(); }
      const holder = document.createElement('div');
      slot.appendChild(holder);
      mix.embedHost = slot;
      api.createController(holder, { uri: 'spotify:track:' + t.id, height: 80 }, (ctl) => {
        mix.embedCtl = ctl;
        ctl.addListener('playback_update', (e) => {
          if (e && e.data) mix.embedState = { pos: e.data.position ?? e.data.progress ?? 0, paused: !!e.data.isPaused, at: Date.now() };
        });
        go(ctl);
      });
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
      ypCtl = null; ypPosMs = null;
      if (!t) yp.innerHTML = '';
      else {
        yp.innerHTML = `
          <div class="your-pick-banner">✓ Your pick: <b>${trackLabel(t)}</b> <span class="muted">(pick another to swap)</span>
            ${t.id ? `
              <div id="yp-embed"></div>
              <span class="muted tiny-note">Voting plays a ${SNIP_SEC}s snippet starting at <b id="yp-start">${t.startSec != null ? fmtTime(t.startSec) : `auto (~${fmtTime(snippetStart(t))})`}</b>. Play or drag to a new spot, then:</span>
              <div class="row snippet-row">
                <button id="snippet-save" class="btn small ghost">📍 Set snippet to current spot</button>
                <button id="yp-preview" class="btn small ghost">▶ Preview my ${SNIP_SEC}s snippet</button>
              </div>
            ` : ''}
          </div>`;
        const save = $('#snippet-save');
        if (save) save.onclick = () => {
          if (ypPosMs == null) return toast('Play or drag your song to the spot you want first');
          submitTrack({ ...t, startSec: Math.floor(ypPosMs / 1000) });
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
    // Snippet starts can change mid-vote — refresh the play buttons.
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
