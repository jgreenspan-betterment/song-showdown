// Headless UI smoke test for Song Showdown: drives the real page through
// three rounds (incl. reveal, tie, finale, impersonation, restore-adjacent flows).
// Run from the repo root:  npm i jsdom && node test/ui-smoke.js
const { JSDOM } = require('jsdom');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const APP = path.join(__dirname, '..');
const PORT = 8917;
const BASE = `http://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let failures = 0;
function check(name, cond) {
  console.log((cond ? 'PASS' : 'FAIL') + '  ' + name);
  if (!cond) failures++;
}

async function serverApi(p, body) {
  const res = await fetch(BASE + p, body ? { method: 'POST', body: JSON.stringify(body) } : {});
  return res.json();
}

(async () => {
  // Fresh server: clear persisted state BEFORE boot (state file lives next to server.js).
  try { fs.unlinkSync(path.join(APP, 'game-state.json')); } catch (_) {}
  // Dummy Spotify creds: enables the server-search UI path; actual Spotify calls will 502.
  const srv = spawn('node', [path.join(APP, 'server.js')], { cwd: __dirname, env: { ...process.env, PORT: String(PORT), SPOTIFY_CLIENT_ID: 'dummy', SPOTIFY_CLIENT_SECRET: 'dummy' } });
  srv.stderr.on('data', (d) => console.log('SRV ERR:', String(d)));
  process.on('exit', () => srv.kill());
  await sleep(400);

  const html = fs.readFileSync(path.join(APP, 'public/index.html'), 'utf8');
  const dom = new JSDOM(html, { url: BASE + '/', runScripts: 'outside-only', pretendToBeVisual: true });
  const { window } = dom;
  window.fetch = (url, opts) => fetch(new URL(url, BASE), opts);
  window.confirm = () => true;
  const errors = [];
  window.addEventListener('error', (e) => errors.push(e.message + ' @ ' + e.filename + ':' + e.lineno));
  process.on('unhandledRejection', (e) => errors.push('rejection: ' + (e && e.stack || e)));

  window.localStorage.setItem('sp_access_token', 'fake-token-for-panel-gate');
  window.eval(fs.readFileSync(path.join(APP, 'public/app.js'), 'utf8'));
  await sleep(300);
  const $ = (s) => window.document.querySelector(s);

  // 1. Join screen
  check('join screen renders', !!$('#name-input'));
  if (!$('#name-input')) { console.log('boot failed:', errors); srv.kill(); process.exit(2); }
  const kd = new window.KeyboardEvent('keydown', { key: 'a', cancelable: true, bubbles: true });
  $('#name-input').dispatchEvent(kd);
  check('typing in name field not blocked', !kd.defaultPrevented);

  $('#name-input').value = 'Dana';
  $('#join-btn').click();
  await sleep(300);
  check('lobby renders after join', $('#phase-root').textContent.includes('Lobby'));
  check('start enabled solo (testing mode)', $('#start-btn') && !$('#start-btn').disabled);
  check('admin panel visible (host + spotify)', !$('#admin-panel').classList.contains('hidden'));
  check('add-test-player button present', !!$('#tt-add'));
  check('remove-all-players button present', !!$('#clear-players-btn'));
  const badClaim = await serverApi('/api/admin', { playerId: 'nobody', token: 'garbage' });
  check('admin claim rejects unknown player', !!badClaim.error);
  $('#tt-add').click();
  await sleep(400);
  check('test player joined', $('#player-list').children.length === 2);
  // Impersonation round-trip
  window.document.querySelector('.tt-imp').click();
  await sleep(400);
  check('identity strip shows impersonated bot', $('#ap-identity').textContent.includes('Impersonating') && $('#ap-identity').textContent.includes('Test 1'));
  check('main screen is the bot view (no start button)', !$('#start-btn') && $('#phase-root').textContent.includes('The host starts the game'));
  $('#tt-back').click();
  await sleep(400);
  check('back to self, start button returns', !!$('#start-btn') && $('#ap-identity').textContent.includes('Acting as'));
  $('#tt-clear').click();
  await sleep(400);
  check('test player removed', $('#player-list').children.length === 1);

  // 2. Two more players join via API
  const ana = (await serverApi('/api/join', { name: 'Ana' })).playerId;
  const ben = (await serverApi('/api/join', { name: 'Ben' })).playerId;
  await window.poll();
  check('player list shows 3', $('#player-list').children.length === 3);
  check('start enabled with 3 players', $('#start-btn') && !$('#start-btn').disabled);

  // 3. Start → Dana (host) picks round 1
  $('#start-btn').click();
  await sleep(300);
  check('picker screen with category chips', window.document.querySelectorAll('.chip.pick').length > 40);
  check('DJ flow styles present', [...window.document.querySelectorAll('.chip.pick')].some((c) => c.dataset.c === 'Peak-hour banger'));
  check('free-type category field present', !!$('#custom-cat'));
  [...window.document.querySelectorAll('.chip.pick')].find((c) => c.dataset.c === 'Earworms').click();
  await sleep(300);

  // 4. Submitting — staged flow + boards
  check('category banner shows Earworms', $('.cat-banner').textContent.includes('Earworms'));
  check('search input shown (server search, no login)', !!$('#search-input'));
  check('all three search tabs when connected', window.document.querySelectorAll('#search-tabs .tab').length === 3);
  check('progress shows 0/3', $('#submit-progress').textContent.includes('0/3'));
  check('bottom submit button present + disabled', $('#submit-song-btn') && $('#submit-song-btn').disabled);
  check('host submit board present', !!$('#submit-board'));
  window.stageTrack({ id: 'abc1234567', name: 'Stage Test', artists: 'X' });
  check('staging enables submit button', !$('#submit-song-btn').disabled);
  check('staged banner shows selection', $('#your-pick').textContent.includes('Stage Test'));
  $('#submit-song-btn').click();
  await sleep(400);
  check('staged song submitted via bottom button', $('#submit-progress').textContent.includes('1/3') && $('#submit-song-btn').disabled);
  check('submit board shows who is in', $('#submit-board').textContent.includes('Dana ✓'));
  $('#search-input').value = 'yellow';
  $('#search-input').dispatchEvent(new window.Event('input', { bubbles: true }));
  await sleep(700);
  check('search error surfaces gracefully (dummy creds)', $('#search-results').textContent.includes('Search hiccup'));
  $('#manual-box').open = true;
  $('#manual-input').value = 'Africa — Toto';
  $('#manual-go').click();
  await sleep(300);
  await window.poll();
  check('manual entry replaces submission', $('#your-pick').textContent.includes('Africa'));
  check('progress still 1/3 after swap', $('#submit-progress').textContent.includes('1/3'));

  await serverApi('/api/submit', { playerId: ana, track: { id: '3AJwUDP919kvQ9QcozQPxg', name: 'Yellow', artists: 'Coldplay', durationMs: 266000, startSec: 75 } });
  await serverApi('/api/submit', { playerId: ben, track: { manual: 'Hey Ya — OutKast' } });
  await window.poll();

  // 5. Voting — round 1
  check('voting screen renders', $('#ballot') && $('#phase-root').textContent.includes('Vote'));
  check('listening party button for host', !!$('#listen-play'));
  check('snippet progress bar wired (voting)', !!$('#listen-progress') && !!$('#listen-fill'));
  check('stepper shows 6 stages', window.document.querySelectorAll('#stepper .step').length === 6);
  check('stepper highlights current stage', $('#stepper .step.cur') && $('#stepper .step.cur').dataset.k === 'voting');
  [...window.document.querySelectorAll('#stepper .step')].find((b) => b.dataset.k === 'submitting').click();
  await sleep(400);
  check('stepper jumps back to submitting (songs kept)', $('#submit-progress') && $('#submit-progress').textContent.includes('3/3'));
  [...window.document.querySelectorAll('#stepper .step')].find((b) => b.dataset.k === 'voting').click();
  await sleep(400);
  check('stepper returns to voting (votes reset)', $('#vote-progress') && $('#vote-progress').textContent.includes('0/3'));
  check('3 song cards', window.document.querySelectorAll('#ballot .song-card').length === 3);
  check('own song marked, no vote button on it', window.document.querySelectorAll('.vote-btn').length === 2 && $('.song-card.mine').textContent.includes('your pick'));
  check('embed slot for spotify track', window.document.querySelectorAll('#ballot .embed-slot').length === 1);
  const snips = window.document.querySelectorAll('.snip-btn');
  check('snippet button only on spotify track', snips.length === 1);
  check('snippet uses submitter start time (75s)', snips[0] && snips[0].dataset.start === '75');
  window.document.querySelector('.vote-btn').click();
  await sleep(300);
  check('vote button flips to Voted', [...window.document.querySelectorAll('.vote-btn')].some((b) => b.textContent.includes('Voted')));
  check('live vote board shows who voted', $('#vote-board') && $('#vote-board').textContent.includes('Dana ✓'));

  // Ana + Ben vote for Dana's song so the DOM client wins round 1
  const st = await serverApi('/api/state?playerId=' + ana);
  const danaSid = st.songs.find((s) => s.track.manual && s.track.manual.includes('Africa')).sid;
  await serverApi('/api/vote', { playerId: ana, sid: danaSid });
  await serverApi('/api/vote', { playerId: ben, sid: danaSid });
  await window.poll();

  // 6. Results — guess mode, then reveal
  check('results screen renders', $('#phase-root').textContent.includes('Results'));
  check('win banner for winner', !!$('.win-banner'));
  check('winner card highlighted with 2 votes', $('.song-card.winner') && $('.song-card.winner').textContent.includes('2'));
  check('names hidden pre-reveal', !$('.song-card.winner').textContent.includes("Dana's pick"));
  check('guess prompt shown (winner sees poker-face note)', $('#phase-root').textContent.includes('poker face'));
  check('host reveal button present', !!$('#reveal-btn'));
  $('#reveal-btn').click();
  await sleep(400);
  check('names revealed after host reveal', $('.song-card.winner').textContent.includes("Dana's pick"));
  check('result cards carry embed players', window.document.querySelectorAll('.embed-slot').length === 1);
  check('history panel visible', !$('#history-panel').classList.contains('hidden'));

  // 7. Winner (Dana) picks round 2
  $('#next-btn').click();
  await sleep(400);
  check('round 2 picker: winner picks', $('#phase-root').textContent.includes('You won — pick the next category'));
  check('round chip shows Round 2', $('#round-chip').textContent === 'Round 2');
  [...window.document.querySelectorAll('.chip.pick')].find((c) => c.dataset.c === 'Peak-hour banger').click();
  await sleep(300);
  await window.submitTrack({ id: '003vvx7Niy0yvhvHt4a68B', name: 'Mr. Brightside', artists: 'The Killers', durationMs: 222000 });
  await sleep(300);
  check('your-pick preview player present', !!$('#yp-embed') && !!$('#yp-preview'));
  check('position readout in your-pick banner', !!$('#yp-pos'));
  await serverApi('/api/submit', { playerId: ana, track: { id: '4uLU6hMCjMI75M1A2tKUQC', name: 'Never Gonna Give You Up', artists: 'Rick Astley', durationMs: 213000, startSec: 43, fadeIn: 3, fadeOut: 4 } });
  await serverApi('/api/submit', { playerId: ben, track: { manual: 'Levels — Avicii' } });
  await window.poll();
  const st2 = await serverApi('/api/state?playerId=' + ana);
  const anaSid = st2.songs.find((x) => x.track.name === 'Never Gonna Give You Up').sid;
  const danaSid2 = st2.songs.find((x) => x.track.name === 'Mr. Brightside').sid;
  check('position readout on own voting card', !!window.document.querySelector('.pos-note'));
  [...window.document.querySelectorAll('.vote-btn')].find((b) => b.dataset.sid === anaSid).click(); // Dana → Ana
  await sleep(200);
  // Mid-vote snippet edit: Ana moves her start to 90s; Dana's ballot button updates on next poll
  await serverApi('/api/snippet', { playerId: ana, startSec: 90 });
  const stSnip = await serverApi('/api/state?playerId=' + ana);
  check('snippet editable during voting', stSnip.songs.find((x) => x.sid === anaSid).track.startSec === 90);
  await window.poll();
  check('ballot play button picks up new start', $(`.snip-btn[data-sid="${anaSid}"]`).dataset.start === '90');
  await serverApi('/api/vote', { playerId: ana, sid: danaSid2 });
  await serverApi('/api/vote', { playerId: ben, sid: anaSid });
  await window.poll();
  check('round 2 results, Dana did not win', $('#phase-root').textContent.includes('Results') && !$('#phase-root').textContent.includes('You won this round'));
  check('guess banner for non-winner host', $('.win-banner') && $('.win-banner').textContent.includes('whose is it'));
  $('#reveal-btn').click();
  await sleep(400);
  check('winner name announced after reveal', $('.win-banner') && $('.win-banner').textContent.includes('Ana'));
  check('finale button visible for host', !!$('#finale-btn'));
  $('#finale-btn').click();
  await sleep(400);

  // 8. Finale
  check('finale screen renders', $('#phase-root').textContent.includes('The Final Mix'));
  check('setlist has 2 winners', window.document.querySelectorAll('#setlist .song-card').length === 2);
  check('setlist shows start time + auto-fade', $('#setlist').textContent.includes('starts 1:30') && $('#setlist').textContent.includes('auto-fade'));
  check('category is the setlist label', [...window.document.querySelectorAll('#setlist .mix-round')].some((el) => el.textContent.includes('Peak-hour banger')));
  check('no fade controls anywhere in user flow', !window.document.querySelector('#fade-in'));
  check('manual winner marked skipped', $('#setlist').textContent.includes('skipped in playback'));
  check('play button enabled (1 playable track)', $('#mix-play') && !$('#mix-play').disabled);
  check('snippet progress bar wired (finale)', !!$('#mix-progress') && !!$('#mix-fill'));
  check('setlist rows show artwork (or placeholder)', window.document.querySelectorAll('#setlist .mix-art').length === 2);
  check('create playlist button (connected host)', !!$('#playlist-btn'));
  check('all submissions archived (2 rounds x 3 songs)', $('#all-songs') && $('#all-songs').textContent.includes('All submissions (6)'));
  await serverApi('/api/playlist', { playerId: window.localStorage.getItem('ssg_player_id'), url: 'https://open.spotify.com/playlist/TESTID123' });
  await window.poll();
  check('playlist link shared to everyone', $('#playlist-link') && $('#playlist-link').getAttribute('href').includes('playlist/TESTID123'));
  check('host can continue playing from finale', !!$('#admin-next'));

  // 9. Keep playing → round 3 (winner Ana picks via API), then a 3-way tie
  $('#admin-next').click();
  await sleep(400);
  check('round 3: winner (Ana) is the picker, host waits', $('#phase-root').textContent.includes('Waiting for') && $('#phase-root').textContent.includes('Ana'));
  await serverApi('/api/category', { playerId: ana, category: 'Cooldown' });
  await window.poll();
  check('winner picked the category', $('.cat-banner') && $('.cat-banner').textContent.includes('Cooldown'));
  await window.submitTrack({ manual: 'Song D' }); // Dana
  await serverApi('/api/submit', { playerId: ana, track: { manual: 'Song A' } });
  await serverApi('/api/submit', { playerId: ben, track: { manual: 'Song B' } });
  await window.poll();
  const st3 = await serverApi('/api/state?playerId=' + ana);
  const sidOf = (m) => st3.songs.find((x) => x.track.manual === m).sid;
  const danaId = window.localStorage.getItem('ssg_player_id');
  await serverApi('/api/vote', { playerId: danaId, sid: sidOf('Song A') });
  await serverApi('/api/vote', { playerId: ana, sid: sidOf('Song B') });
  await serverApi('/api/vote', { playerId: ben, sid: sidOf('Song D') });
  await window.poll();
  check('tie announced', $('#phase-root').textContent.includes('3-way tie'));
  check('tied cards flagged', window.document.querySelectorAll('.tie-chip').length === 3);
  check('a winner was still drawn', !!$('.song-card.winner'));
  check('history notes the tie-break', $('#history-list').textContent.includes('tie-break'));

  // 10. Remove all players (host stays) + wipe epoch
  await serverApi('/api/clear-players', { playerId: danaId });
  await window.poll();
  check('remove-all keeps only the host', $('#player-list').children.length === 1 && $('#player-list').textContent.includes('Dana'));
  const wiped = await serverApi('/api/state?playerId=');
  check('wipe epoch bumped (blocks auto-rejoin)', wiped.wipe === 1);

  check('no page JS errors', errors.length === 0);
  if (errors.length) console.log('errors:', errors);

  srv.kill();
  try { fs.unlinkSync(path.join(APP, 'game-state.json')); } catch (_) {}
  console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURES`);
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error('TEST CRASH:', e); process.exit(2); });
