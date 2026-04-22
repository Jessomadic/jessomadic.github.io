// ============================================================
//  PickFlick — app.js
//  Plex movie swiping app with Firebase real-time sync
// ============================================================

// Firebase compat SDK is loaded via <script> tags in index.html.
// window.firebaseConfig is injected by firebase-config.js (also a plain script).
// No ES module imports — avoids CDN/CORS/CSP fragility on static sites.

// ── Constants ────────────────────────────────────────────────
const PLEX_PRODUCT   = 'PickFlick';
const MOVIES_COUNT   = 30;
const SEQUEL_MAX_RATIO = 0.20;  // at most 20 % of the picked pool can be sequels
const THRESHOLD      = 0.5;   // majority = > 50%
const POLL_INTERVAL  = 2000;  // ms between Plex PIN polls
const AUTH_TIMEOUT   = 5 * 60 * 1000; // 5 min

// TMDB image CDN — no auth required once you have the poster_path.
// API key is injected by CI from the TMDB_API_KEY GitHub Actions secret.
// w342 is wide enough for swipe cards (300 × 450 display size) without
// over-fetching; fall back to w500 for the winner overlay if you ever
// need higher resolution.
const TMDB_IMAGE_BASE = 'https://image.tmdb.org/t/p/w342';

// ── Wheel constants ───────────────────────────────────────────
const WHEEL_COLORS = [
  '#a855f7','#ec4899','#f97316','#eab308',
  '#22c55e','#06b6d4','#8b5cf6','#f43f5e',
  '#84cc16','#0ea5e9',
];
const SPIN_DURATION   = 4200; // ms — ease-out quartic, feels dramatic
const SPIN_EXTRA_LAPS = 8;    // full extra rotations before landing

// ── State ────────────────────────────────────────────────────
let db = null;
let sessionUnsubscribe = null;
let wheelUnsubscribe   = null;
let wheelMovies        = [];     // current remaining movie objects on the wheel
let wheelRotation      = 0;      // current canvas rotation in radians
let wheelAnimating     = false;
let _latestWheelData   = null;   // most recent wheel snapshot from Firebase
let _lastAnimatedSpinId = null;  // dedup: prevent re-animating the same spin

const state = {
  role:        null,   // 'host' | 'guest'
  userId:      uid(),
  clientId:    cid(),
  userName:    null,
  sessionCode: null,
  plexToken:   null,   // never persisted beyond sessionStorage
  plexServers: [],
  plexServerUri: null,
  plexImageUri:  null,
  plexLibrary: null,
  movies:      [],
  swipes:      {},     // { movieId: true|false }
  currentIdx:  0,
};

// ── ID helpers ───────────────────────────────────────────────
function uid() {
  let id = sessionStorage.getItem('pf_uid');
  if (!id) { id = uuid(); sessionStorage.setItem('pf_uid', id); }
  return id;
}
function cid() {
  let id = sessionStorage.getItem('pf_cid');
  if (!id) { id = uuid(); sessionStorage.setItem('pf_cid', id); }
  return id;
}
function uuid() {
  return crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}
function generateCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  return Array.from({ length: 6 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
}
function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// ── Screen management ────────────────────────────────────────
function showScreen(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  const el = document.getElementById(id);
  if (el) el.classList.add('active');
}

let toastTimer;
function toast(msg, type = 'info') {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.className = `show${type === 'error' ? ' error' : ''}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.className = ''; }, 3500);
}

function setBtn(id, loading, text = '') {
  const el = document.getElementById(id);
  if (!el) return;
  el.disabled = loading;
  el.innerHTML = loading ? '<span class="spinner-sm"></span>' : text;
}

// ── Firebase (compat SDK) ─────────────────────────────────────
// firebase-app-compat.js and firebase-database-compat.js expose the
// global `firebase` object. Config is on window.firebaseConfig.
let _listenRef  = null;
let _listenCb   = null;
let _wheelRef   = null;   // separate listener slot for the wheel (avoids stomping the session listener)
let _wheelCb    = null;

function initFirebase() {
  const config = window.firebaseConfig;
  if (!config || config.apiKey === 'YOUR_API_KEY') return false;
  try {
    firebase.initializeApp(config);
    db = firebase.database();
    return true;
  } catch (e) {
    console.error('Firebase init error:', e);
    return false;
  }
}

async function fbSet(path, data)    { await db.ref(path).set(data); }
async function fbGet(path)          { return (await db.ref(path).once('value')).val(); }
async function fbUpdate(path, data) { await db.ref(path).update(data); }

function fbListen(path, cb) {
  // Tear down any previous listener
  if (_listenRef && _listenCb) _listenRef.off('value', _listenCb);
  _listenCb  = snap => cb(snap.val());
  _listenRef = db.ref(path);
  _listenRef.on('value', _listenCb);
  // Return an unsubscribe function compatible with the existing callers
  return () => {
    if (_listenRef) { _listenRef.off('value', _listenCb); _listenRef = null; _listenCb = null; }
  };
}

// Dedicated listener for the wheel — never shares state with fbListen so
// setting up the wheel never accidentally removes the session listener.
function wheelListen(path, cb) {
  if (_wheelRef && _wheelCb) _wheelRef.off('value', _wheelCb);
  _wheelCb = snap => cb(snap.val());
  _wheelRef = db.ref(path);
  _wheelRef.on('value', _wheelCb);
  return () => {
    if (_wheelRef) { _wheelRef.off('value', _wheelCb); _wheelRef = null; _wheelCb = null; }
  };
}

// ── Plex API ─────────────────────────────────────────────────
function plexHeaders(token = null) {
  const h = {
    'X-Plex-Client-Identifier': state.clientId,
    'X-Plex-Product': PLEX_PRODUCT,
    'X-Plex-Version': '1.0',
    'X-Plex-Platform': 'Web',
    'Accept': 'application/json',
  };
  if (token) h['X-Plex-Token'] = token;
  return h;
}

async function plexCreatePin() {
  const r = await fetch('https://plex.tv/api/v2/pins?strong=true', {
    method: 'POST', headers: plexHeaders(),
  });
  if (!r.ok) throw new Error('Could not reach Plex.tv — check your connection.');
  return r.json();
}

function openPlexAuth(code) {
  const params = new URLSearchParams({
    clientID: state.clientId,
    code,
    'context[device][product]': PLEX_PRODUCT,
    forwardUrl: window.location.href,
  });
  const url = `https://app.plex.tv/auth#?${params}`;
  const popup = window.open(url, 'plex_auth', 'width=520,height=700,scrollbars=yes');
  if (!popup || popup.closed) {
    // Popup blocked — show inline link
    const el = document.getElementById('auth-status');
    el.style.display = 'flex';
    el.innerHTML = `<span>Popup blocked — <a href="${url}" target="_blank" style="color:var(--purple)">click here to sign in</a>, then return to this tab.</span>`;
  }
  return popup;
}

function pollPin(pinId) {
  return new Promise((resolve, reject) => {
    const iv = setInterval(async () => {
      try {
        const r = await fetch(`https://plex.tv/api/v2/pins/${pinId}`, { headers: plexHeaders() });
        if (!r.ok) return;
        const pin = await r.json();
        if (pin.authToken) { clearInterval(iv); clearTimeout(to); resolve(pin.authToken); }
      } catch { /* network blip, keep polling */ }
    }, POLL_INTERVAL);
    const to = setTimeout(() => { clearInterval(iv); reject(new Error('Sign-in timed out. Please try again.')); }, AUTH_TIMEOUT);
  });
}

async function plexGetServers(token) {
  const r = await fetch('https://plex.tv/api/v2/resources?includeHttps=1&includeRelay=1', {
    headers: plexHeaders(token),
  });
  if (!r.ok) throw new Error('Failed to fetch your Plex servers.');
  const all = await r.json();
  return all.filter(s => s.provides?.includes('server') && s.connections?.length);
}

async function bestUri(server, token) {
  // Sort: HTTPS relay first, then HTTPS direct, then anything
  const conns = server.connections
    .filter(c => c.uri?.startsWith('https'))
    .sort((a, b) => (b.relay ? 1 : 0) - (a.relay ? 1 : 0));

  let firstWorkingRelay = null;
  let firstWorkingUri   = null;

  for (const c of conns) {
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 5000);
      const r = await fetch(`${c.uri}/identity`, {
        headers: plexHeaders(token), signal: ctrl.signal,
      });
      clearTimeout(t);
      if (r.ok) {
        if (!firstWorkingUri) firstWorkingUri = c.uri;
        if (c.relay && !firstWorkingRelay) firstWorkingRelay = c.uri;
        // If we already have the fastest URI and a relay, stop early
        if (firstWorkingUri && firstWorkingRelay) break;
        // Relays are sorted first; once we're in the direct section there are no more
        // relays to discover, so stop as soon as we have a working direct URI.
        if (firstWorkingUri && !c.relay) break;
      }
    } catch { /* try next */ }
  }

  const fallback = (server.connections.find(c => c.relay) ?? server.connections[0]).uri;
  const apiUri   = firstWorkingUri ?? fallback;
  // For images (loaded via <img> tags which handle failures gracefully),
  // prefer ANY relay — even untested — so guests on other networks can reach it.
  const anyRelay = server.connections.find(c => c.relay)?.uri;
  const imageUri = firstWorkingRelay ?? anyRelay ?? apiUri;
  return { apiUri, imageUri };
}

async function plexGetLibraries(uri, token) {
  const r = await fetch(`${uri}/library/sections`, { headers: plexHeaders(token) });
  if (!r.ok) throw new Error('Could not load Plex libraries.');
  const d = await r.json();
  return (d.MediaContainer.Directory ?? []).filter(lib => lib.type === 'movie');
}

async function plexGetGenres(uri, sectionKey, token) {
  try {
    const r = await fetch(`${uri}/library/sections/${sectionKey}/genre`, { headers: plexHeaders(token) });
    if (!r.ok) return [];
    const d = await r.json();
    return d.MediaContainer.Directory ?? [];
  } catch { return []; }
}

async function plexGetMovies(uri, sectionKey, genreFastKey, token) {
  let url = genreFastKey
    ? `${uri}${genreFastKey}`
    : `${uri}/library/sections/${sectionKey}/all?type=1`;
  url += '&X-Plex-Container-Start=0&X-Plex-Container-Size=5000';

  const r = await fetch(url, { headers: plexHeaders(token) });
  if (!r.ok) throw new Error('Failed to fetch movies from Plex.');
  const d = await r.json();
  return d.MediaContainer.Metadata ?? [];
}

// Fetch a single TMDB poster URL for a raw Plex movie object.
// Plex embeds external IDs in m.Guid, e.g. [{id:"tmdb://27205"},{id:"imdb://tt1375666"}].
// Returns the image.tmdb.org CDN URL, or null on any failure.
async function fetchTmdbPoster(m, apiKey) {
  const tmdbGuid = (m.Guid ?? []).find(g => g.id?.startsWith('tmdb://'));
  if (!tmdbGuid) return null;
  const tmdbId = tmdbGuid.id.slice('tmdb://'.length);
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 5000);
    const r = await fetch(
      `https://api.themoviedb.org/3/movie/${encodeURIComponent(tmdbId)}?api_key=${apiKey}&language=en-US`,
      { signal: ctrl.signal },
    );
    clearTimeout(t);
    if (!r.ok) return null;
    const d = await r.json();
    return d.poster_path ? `${TMDB_IMAGE_BASE}${d.poster_path}` : null;
  } catch { return null; }
}

// Batch-fetch TMDB poster URLs for an array of raw Plex movies in parallel.
// Returns a Map of ratingKey → TMDB CDN URL.
// Silently skips if window.tmdbApiKey is not configured.
async function fetchTmdbPosters(rawMovies) {
  const apiKey = window.tmdbApiKey;
  if (!apiKey || apiKey === 'YOUR_TMDB_API_KEY') return {};
  const pairs = await Promise.allSettled(
    rawMovies.map(m =>
      fetchTmdbPoster(m, apiKey).then(url => ({ key: String(m.ratingKey), url }))
    )
  );
  const map = {};
  for (const r of pairs) {
    if (r.status === 'fulfilled' && r.value.url) map[r.value.key] = r.value.url;
  }
  return map;
}

function formatMovie(m, plexUri, token, tmdbUrl = null) {
  // Prefer TMDB poster (globally accessible CDN, no auth) over Plex relay.
  // Plex relay URL is kept as the fallback for movies with no TMDB match.
  const plexPoster = m.thumb
    ? `${plexUri}${m.thumb}?X-Plex-Token=${token}&width=300&height=450`
    : null;
  return {
    id:            String(m.ratingKey),
    title:         m.title ?? 'Unknown',
    year:          m.year ? String(m.year) : '',
    summary:       (m.summary ?? '').slice(0, 220),
    rating:        m.rating ? parseFloat(m.rating).toFixed(1) : null,
    contentRating: m.contentRating ?? '',
    duration:      m.duration ? `${Math.round(m.duration / 60000)} min` : '',
    genres:        (m.Genre ?? []).map(g => g.tag).slice(0, 3),
    poster:        tmdbUrl ?? plexPoster,
  };
}

// ── Session helpers ───────────────────────────────────────────
async function createSession(movies) {
  const code = generateCode();
  const session = {
    hostId:    state.userId,
    createdAt: Date.now(),
    status:    'lobby',
    settings:  { threshold: THRESHOLD },
    movies,
    participants: {
      [state.userId]: {
        name:     state.userName,
        isHost:   true,
        joinedAt: Date.now(),
        done:     false,
      },
    },
    swipes: {},
  };
  await fbSet(`sessions/${code}`, session);
  return code;
}

async function joinSession(code) {
  const session = await fbGet(`sessions/${code}`);
  if (!session) throw new Error('Session not found. Check the code and try again.');
  if (session.status === 'done') throw new Error('That session has already ended.');
  const count = Object.keys(session.participants ?? {}).length;
  if (count >= 4) throw new Error('Session is full (max 4 people).');

  // Add participant
  await fbUpdate(`sessions/${code}/participants/${state.userId}`, {
    name:     state.userName,
    isHost:   false,
    joinedAt: Date.now(),
    done:     false,
  });
  return session;
}

// ── Lobby ────────────────────────────────────────────────────
function showLobby(code, isHost) {
  state.sessionCode = code;
  sessionStorage.setItem('pf_session', code);
  sessionStorage.setItem('pf_role', state.role);

  document.getElementById('lobby-code').textContent = code;
  document.getElementById('lobby-host-actions').style.display = isHost ? '' : 'none';
  document.getElementById('lobby-guest-wait').style.display   = isHost ? 'none' : '';
  showScreen('screen-lobby');

  sessionUnsubscribe = fbListen(`sessions/${code}`, onSessionUpdate);
}

function updateLobbyParticipants(participants) {
  const list  = document.getElementById('participant-list');
  const count = document.getElementById('participant-count');
  const entries = Object.values(participants ?? {});
  count.textContent = `${entries.length}/4`;
  list.innerHTML = entries.map(p => `
    <div class="chip">
      <div class="dot"></div>
      ${escHtml(p.name)}${p.isHost ? ' <span style="color:var(--purple);font-size:11px">HOST</span>' : ''}
    </div>`).join('');
}

// ── Session real-time listener ───────────────────────────────
function onSessionUpdate(session) {
  if (!session) return;

  const activeScreen = document.querySelector('.screen.active')?.id;

  // Update lobby participants wherever we are
  if (activeScreen === 'screen-lobby') {
    updateLobbyParticipants(session.participants);
  }

  // Update waiting screen progress
  if (activeScreen === 'screen-waiting') {
    updateWaitingProgress(session.participants);
  }

  // Host transitions: lobby → swiping (when host clicks start)
  if (session.status === 'swiping' && (activeScreen === 'screen-lobby')) {
    state.movies = session.movies ?? [];
    startSwiping();
    return;
  }

  // Everyone done → results (skip if already showing results or the wheel)
  if (session.status === 'done' &&
      activeScreen !== 'screen-results' &&
      activeScreen !== 'screen-wheel') {
    showResults(session);
    return;
  }

  // Check if all done while we're on waiting screen
  if (activeScreen === 'screen-waiting') {
    const parts = Object.values(session.participants ?? {});
    const allDone = parts.length > 0 && parts.every(p => p.done);
    if (allDone && session.status !== 'done') {
      // Trigger results (host marks session done)
      if (state.role === 'host') {
        fbUpdate(`sessions/${state.sessionCode}`, { status: 'done' });
      }
    }
    if (session.status === 'done') {
      showResults(session);
    }
  }
}

// ── Swipe UI ─────────────────────────────────────────────────
function startSwiping() {
  state.currentIdx = 0;
  state.swipes = {};
  state.movies = shuffle(state.movies);
  showScreen('screen-swipe');
  document.getElementById('swipe-session-code').textContent = state.sessionCode;
  renderStack();
  updateProgress();
}

function renderStack() {
  const stack = document.getElementById('swipe-stack');
  stack.innerHTML = '';

  // Render 3 cards, bottom-first so top card is last in DOM (highest z)
  const toRender = Math.min(3, state.movies.length - state.currentIdx);
  for (let offset = toRender - 1; offset >= 0; offset--) {
    const movie = state.movies[state.currentIdx + offset];
    if (!movie) continue;
    const card = buildCard(movie);
    const scale = 1 - offset * 0.04;
    const ty    = -offset * 10;
    card.style.transform  = `scale(${scale}) translateY(${ty}px)`;
    card.style.zIndex     = 10 - offset;
    card.style.transition = 'transform .3s ease';
    if (offset === 0) attachDrag(card, movie.id);
    stack.appendChild(card);
  }

  // Preload the next card's poster so it's in the browser cache by the time
  // renderStack is called again (after a swipe).  This prevents a flash of
  // empty/loading poster when the stack replenishes on slow connections.
  const nextMovie = state.movies[state.currentIdx + toRender];
  if (nextMovie?.poster) {
    const preload = new Image();
    preload.src = nextMovie.poster;
  }

  // Disable buttons when no cards left
  const noneLeft = state.currentIdx >= state.movies.length;
  document.getElementById('btn-nope').disabled = noneLeft;
  document.getElementById('btn-like').disabled = noneLeft;
}

function buildCard(movie) {
  const card = document.createElement('div');
  card.className = 'swipe-card';
  card.dataset.id = movie.id;

  const posterHtml = movie.poster
    ? `<img src="${movie.poster}" alt="${escHtml(movie.title)}" loading="lazy" onerror="this.style.display='none';this.closest('.card-poster').querySelector('.poster-placeholder').style.display='flex'">`
    : '';
  const metaParts = [movie.year, movie.duration, movie.rating ? `⭐ ${movie.rating}` : null].filter(Boolean);
  const badge = movie.contentRating ? `<span class="badge">${escHtml(movie.contentRating)}</span>` : '';
  const genres = movie.genres.length
    ? `<div class="genre-tags">${movie.genres.map(g => `<span class="genre-tag">${escHtml(g)}</span>`).join('')}</div>`
    : '';

  card.innerHTML = `
    <div class="card-poster">
      ${posterHtml}
      <div class="poster-placeholder" style="display:${movie.poster ? 'none' : 'flex'}">🎬</div>
      <div class="poster-overlay"></div>
      <div class="card-color-overlay"></div>
      <div class="stamp stamp-like">LIKE</div>
      <div class="stamp stamp-nope">NOPE</div>
    </div>
    <div class="card-info">
      <div>
        <div class="card-title">${escHtml(movie.title)}</div>
        <div class="card-meta">
          ${metaParts.map(p => `<span>${escHtml(String(p))}</span>`).join('<span>·</span>')}
          ${badge}
        </div>
      </div>
      ${movie.summary ? `<p class="card-summary">${escHtml(movie.summary)}</p>` : ''}
      ${genres}
    </div>`;
  return card;
}

function attachDrag(card, movieId) {
  let startX = 0, startY = 0, curX = 0, curY = 0, dragging = false;

  const overlay = card.querySelector('.card-color-overlay');
  const stampL  = card.querySelector('.stamp-like');
  const stampN  = card.querySelector('.stamp-nope');

  function onStart(x, y) {
    dragging = true; startX = x; startY = y;
    card.style.transition = 'none';
  }

  function onMove(x, y) {
    if (!dragging) return;
    curX = x - startX; curY = y - startY;
    const rot = curX * 0.07;
    card.style.transform = `translateX(${curX}px) translateY(${curY}px) rotate(${rot}deg)`;
    const likeAmt = Math.min(Math.max(curX  / 100, 0), 1);
    const nopeAmt = Math.min(Math.max(-curX / 100, 0), 1);
    stampL.style.opacity = likeAmt;
    stampN.style.opacity = nopeAmt;
    overlay.style.background = curX > 0
      ? `rgba(74,222,128,${likeAmt * 0.28})`
      : `rgba(248,113,113,${nopeAmt * 0.28})`;
  }

  // Named references so we can remove them from window later
  const handleMouseMove = e => onMove(e.clientX, e.clientY);
  const handleMouseUp   = () => handleEnd();

  function handleEnd() {
    if (!dragging) return;
    dragging = false;
    // Always remove window listeners when the drag ends
    window.removeEventListener('mousemove', handleMouseMove);
    window.removeEventListener('mouseup',   handleMouseUp);

    if (Math.abs(curX) > 90) {
      flyOff(card, curX > 0, movieId);
    } else {
      card.style.transition = 'transform .35s ease';
      card.style.transform  = 'scale(1) translateY(0)';
      stampL.style.opacity  = 0;
      stampN.style.opacity  = 0;
      overlay.style.background = 'transparent';
    }
  }

  card.addEventListener('mousedown', e => {
    e.preventDefault();
    onStart(e.clientX, e.clientY);
    // Re-attach window listeners each drag start (they are removed on end)
    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup',   handleMouseUp);
  });

  card.addEventListener('touchstart', e => { e.preventDefault(); onStart(e.touches[0].clientX, e.touches[0].clientY); }, { passive: false });
  card.addEventListener('touchmove',  e => { e.preventDefault(); onMove(e.touches[0].clientX, e.touches[0].clientY); },  { passive: false });
  card.addEventListener('touchend',   () => handleEnd());
}

function flyOff(card, liked, movieId) {
  card.style.transition = 'transform .4s ease, opacity .4s ease';
  card.style.transform  = liked ? 'translateX(150vw) rotate(30deg)' : 'translateX(-150vw) rotate(-30deg)';
  card.style.opacity    = '0';
  setTimeout(() => {
    card.remove();
    recordSwipe(liked, movieId);
  }, 380);
}

function triggerSwipe(liked) {
  // Cards are appended bottom-first; the TOP card is the LAST child in the DOM.
  const cards = document.querySelectorAll('#swipe-stack .swipe-card');
  const top = cards[cards.length - 1];
  if (!top) return;
  flyOff(top, liked, top.dataset.id);
}

function recordSwipe(liked, movieId) {
  state.swipes[movieId] = liked;
  state.currentIdx++;
  updateProgress();

  if (state.currentIdx >= state.movies.length) {
    finishSwiping();
    return;
  }
  // Refresh stack (remove old top, restack remaining)
  renderStack();
}

function updateProgress() {
  const total = state.movies.length;
  const done  = state.currentIdx;
  const pct   = total ? (done / total) * 100 : 0;
  document.getElementById('swipe-progress-fill').style.width = `${pct}%`;
  document.getElementById('swipe-counter').textContent = `${done} / ${total}`;
}

async function finishSwiping() {
  showScreen('screen-waiting');
  // Batch-write swipes + mark done via multi-path root update
  const updates = {};
  Object.entries(state.swipes).forEach(([mid, liked]) => {
    updates[`sessions/${state.sessionCode}/swipes/${state.userId}/${mid}`] = liked;
  });
  updates[`sessions/${state.sessionCode}/participants/${state.userId}/done`] = true;
  try {
    await db.ref('/').update(updates);
  } catch (e) {
    toast('Error saving swipes — check your connection.', 'error');
  }
  // Keep listening; onSessionUpdate will fire when all done
}

function updateWaitingProgress(participants) {
  const list = document.getElementById('waiting-participant-list');
  list.innerHTML = Object.values(participants ?? {}).map(p => `
    <div class="chip">
      <div class="dot ${p.done ? 'done' : 'waiting'}"></div>
      ${escHtml(p.name)} ${p.done ? '✓' : '…'}
    </div>`).join('');
}

// ── Results ───────────────────────────────────────────────────
function showResults(session) {
  const movies       = session.movies ?? [];
  const allSwipes    = session.swipes ?? {};
  const participants = session.participants ?? {};
  const pCount       = Object.keys(participants).length;

  const matches = movies
    .map(movie => {
      const yesVotes = Object.values(allSwipes).filter(u => u[movie.id] === true).length;
      const pct      = pCount ? yesVotes / pCount : 0;
      return { movie, pct, yesVotes };
    })
    .filter(({ pct }) => pct > THRESHOLD)
    .sort((a, b) => b.pct - a.pct);

  // 2+ matches → spin the wheel to pick one
  if (matches.length >= 2) {
    showWheel(session, matches.map(m => m.movie));
    return;
  }

  // 0 or 1 match → plain results screen
  const emoji    = document.getElementById('results-emoji');
  const headline = document.getElementById('results-headline');
  const sub      = document.getElementById('results-sub');
  const list     = document.getElementById('results-list');

  if (matches.length === 0) {
    emoji.textContent    = '😬';
    headline.textContent = 'No matches this round…';
    sub.textContent      = 'Tough crowd! Try a different genre or pick again.';
    list.innerHTML       = '<div class="empty-state"><span class="emoji">🎭</span><p>Nothing matched — someone has very specific taste!</p></div>';
  } else {
    const { movie, yesVotes } = matches[0];
    emoji.textContent    = '🎬';
    headline.textContent = 'You matched a movie!';
    sub.textContent      = `${pCount} ${pCount === 1 ? 'person' : 'people'} · majority agreed`;
    list.innerHTML       = `
      <div class="result-item">
        ${movie.poster
          ? `<img class="result-poster" src="${movie.poster}" alt="${escHtml(movie.title)}" loading="lazy" onerror="this.style.display='none';this.nextElementSibling.style.display='flex'"><div class="result-poster-placeholder" style="display:none">🎬</div>`
          : `<div class="result-poster-placeholder">🎬</div>`}
        <div style="flex:1;min-width:0">
          <div style="font-weight:700;font-size:16px;margin-bottom:2px">${escHtml(movie.title)}</div>
          <div class="text-muted" style="font-size:13px">${[movie.year, movie.duration].filter(Boolean).join(' · ')}</div>
          ${movie.genres.length ? `<div class="genre-tags" style="margin-top:4px">${movie.genres.map(g => `<span class="genre-tag">${escHtml(g)}</span>`).join('')}</div>` : ''}
        </div>
        <div class="match-pct">${yesVotes}/${pCount}</div>
      </div>`;
  }
  showScreen('screen-results');
}

// ── Wheel ─────────────────────────────────────────────────────
//  Players take turns spinning; the movie the pointer lands on is
//  eliminated. Last movie standing is tonight's pick.
//
//  Firebase path: sessions/${code}/wheel = {
//    remaining:    [{movie}, ...],   full movie objects still on the wheel
//    eliminated:   [movieId, ...],   in elimination order
//    spinIndex:    Number,           incremented after each spin
//    turnOrder:    [{userId,name}],  fixed cycle, derived from participants
//    pendingSpin:  null | { eliminateId, targetAngle },
//    winner:       null | movieId
//  }

function showWheel(session, matchedMovies) {
  // Build turn order sorted by joinedAt so it's deterministic for everyone
  const parts = session.participants ?? {};
  const turnOrder = Object.entries(parts)
    .sort(([, a], [, b]) => a.joinedAt - b.joinedAt)
    .map(([userId, p]) => ({ userId, name: p.name }));

  // Reset local wheel state
  wheelMovies    = matchedMovies.slice();
  wheelRotation  = 0;
  wheelAnimating = false;

  showScreen('screen-wheel');
  drawWheel(wheelMovies, wheelRotation);

  // Subscribe to wheel updates via the dedicated wheel listener slot so it
  // never tears down the session listener that fbListen manages.
  if (wheelUnsubscribe) wheelUnsubscribe();
  wheelUnsubscribe = wheelListen(`sessions/${state.sessionCode}/wheel`, onWheelUpdate);

  // Only the host writes the initial wheel state to Firebase
  if (state.role === 'host') initWheelFirebase(matchedMovies, turnOrder);
}

async function initWheelFirebase(movies, turnOrder) {
  try {
    const existing = await fbGet(`sessions/${state.sessionCode}/wheel`);
    if (existing) return; // reload recovery — don't overwrite in-progress wheel
    await fbSet(`sessions/${state.sessionCode}/wheel`, {
      remaining:    movies,
      eliminated:   [],
      spinIndex:    0,
      turnOrder,
      pendingSpin:  null,
      winner:       null,
    });
  } catch (e) {
    toast('Failed to initialize the wheel — check your connection and reload.', 'error');
  }
}

function onWheelUpdate(wheelData) {
  if (!wheelData) return;
  _latestWheelData = wheelData;

  // Defensive: Firebase RTDB can convert arrays to objects in edge cases
  const remaining  = Array.isArray(wheelData.remaining)  ? wheelData.remaining  : Object.values(wheelData.remaining  ?? {});
  const eliminated = Array.isArray(wheelData.eliminated)  ? wheelData.eliminated  : Object.values(wheelData.eliminated  ?? {});
  const turnOrder  = Array.isArray(wheelData.turnOrder)   ? wheelData.turnOrder   : Object.values(wheelData.turnOrder   ?? {});
  const spinIndex    = wheelData.spinIndex    ?? 0;
  const pendingSpin  = wheelData.pendingSpin;
  const winner       = wheelData.winner;

  // Build movie lookup from remaining (full objects stored in Firebase)
  // Also include state.movies so eliminated titles can still be resolved
  const movieById = {};
  state.movies.forEach(m => { if (m && m.id) movieById[m.id] = m; });
  remaining.forEach(m =>     { if (m && m.id) movieById[m.id] = m; });

  const currentTurn = turnOrder[spinIndex % turnOrder.length] ?? {};
  const isMyTurn    = currentTurn.userId === state.userId;

  // Remaining count badge
  document.getElementById('wheel-remaining-label').textContent = `${remaining.length} left`;

  // Eliminated chips (crossed-out titles below wheel)
  document.getElementById('wheel-elim-row').innerHTML = eliminated.map(id => {
    const m = movieById[id];
    return m ? `<div class="wheel-elim-chip">${escHtml(m.title)}</div>` : '';
  }).join('');

  // Winner — show overlay
  if (winner) {
    const winnerMovie = movieById[winner];
    if (winnerMovie) showWheelWinner(winnerMovie);
    document.getElementById('btn-spin').disabled = true;
    return;
  }

  // Turn label
  const label = document.getElementById('wheel-turn-label');
  if (pendingSpin) {
    label.textContent = '🌀 Spinning…';
    label.className   = 'wheel-turn-label';
  } else if (isMyTurn) {
    label.textContent = '🎯 Your turn — spin it!';
    label.className   = 'wheel-turn-label wheel-my-turn';
  } else {
    label.textContent = `⏳ ${escHtml(currentTurn.name || 'Someone')}'s turn…`;
    label.className   = 'wheel-turn-label wheel-other-turn';
  }

  // ── Animation / static display ──
  // The flag tracks whether we just kicked off a NEW animation in this call.
  let animationStarted = false;

  if (pendingSpin && !wheelAnimating) {
    const spinId = `${spinIndex}:${pendingSpin.eliminateId}`;
    if (spinId !== _lastAnimatedSpinId) {
      _lastAnimatedSpinId = spinId;
      animationStarted = true;
      const { eliminateId, targetAngle } = pendingSpin;
      const localTarget = computeSpinTarget(targetAngle, wheelRotation, SPIN_EXTRA_LAPS);

      wheelMovies = remaining.slice();
      wheelAnimating = true;
      drawWheel(wheelMovies, wheelRotation);

      animateSpin(localTarget, SPIN_DURATION, () => {
        wheelRotation  = targetAngle;
        wheelMovies    = remaining.filter(m => m.id !== eliminateId);
        wheelAnimating = false;
        drawWheel(wheelMovies, wheelRotation);

        // The spinner commits the elimination to Firebase.
        // Guard: skip if the Firebase state has already advanced past this spin
        // (can happen when the commit round-trips back mid-animation and another
        // player spins before our callback fires, which would overwrite their
        // pendingSpin with null).
        if (currentTurn.userId === state.userId &&
            (_latestWheelData?.spinIndex ?? spinIndex) === spinIndex) {
          const newRemaining  = remaining.filter(m => m.id !== eliminateId);
          const newEliminated = [...eliminated, eliminateId];
          fbUpdate(`sessions/${state.sessionCode}/wheel`, {
            remaining:    newRemaining,
            eliminated:   newEliminated,
            spinIndex:    spinIndex + 1,
            pendingSpin:  null,
            winner:       newRemaining.length <= 1 ? (newRemaining[0]?.id ?? null) : null,
          }).catch(() => {
            // Network failure — allow the spin to be retried by clearing the dedup key
            toast('Connection error saving spin — please try again.', 'error');
            _lastAnimatedSpinId = null;
          });
        }

        // Re-process the latest Firebase state now that animation is done.
        // The spinner's commit may have arrived mid-animation; if so,
        // _latestWheelData already has the updated state (pendingSpin cleared,
        // spinIndex bumped).  Re-calling onWheelUpdate applies it.
        if (_latestWheelData) onWheelUpdate(_latestWheelData);
      });
    }
  }

  // ── Button + static draw ──
  // Always update the button — even if we just started an animation.
  if (animationStarted) {
    document.getElementById('btn-spin').disabled = true;
  } else if (!wheelAnimating) {
    // Static: no animation in progress — sync the wheel display if the data
    // has moved past the last pending spin (avoids flashing the eliminated
    // movie back onto the wheel).
    if (!pendingSpin) {
      wheelMovies = remaining.slice();
      drawWheel(wheelMovies, wheelRotation);
    }
    document.getElementById('btn-spin').disabled = !isMyTurn || !!pendingSpin;
  } else {
    // Animation from a previous onWheelUpdate is still running
    document.getElementById('btn-spin').disabled = true;
  }
}

// How far (clockwise) from currentRotation to reach finalAngle, plus extra laps.
// Always spins at least one full rotation beyond extraLaps so the wheel never
// just twitches when finalAngle happens to be close to the current position.
function computeSpinTarget(finalAngle, currentRotation, extraLaps) {
  const TAU         = 2 * Math.PI;
  const normalized  = ((currentRotation % TAU) + TAU) % TAU;
  // Clockwise distance from current normalised angle to finalAngle (0 < dist ≤ TAU)
  let dist = ((finalAngle - normalized) + TAU) % TAU;
  if (dist < 0.001) dist = TAU; // land exactly on current position → full extra lap
  return currentRotation + dist + extraLaps * TAU;
}

function drawWheel(movies, rotation) {
  const canvas = document.getElementById('wheel-canvas');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const W = canvas.width, H = canvas.height;
  const cx = W / 2, cy = H / 2;
  const r  = Math.min(cx, cy) - 4;

  ctx.clearRect(0, 0, W, H);

  if (!movies.length) {
    ctx.beginPath(); ctx.arc(cx, cy, r, 0, 2 * Math.PI);
    ctx.fillStyle = '#1c1c2e'; ctx.fill();
    return;
  }

  const n          = movies.length;
  const sliceAngle = (2 * Math.PI) / n;
  const fontSize   = n <= 4 ? 14 : n <= 8 ? 12 : 10;
  const maxChars   = n <= 4 ? 18 : n <= 8 ? 13 : 9;

  movies.forEach((movie, i) => {
    const start = rotation + i * sliceAngle - Math.PI / 2;
    const end   = start + sliceAngle;
    const mid   = start + sliceAngle / 2;
    const color = WHEEL_COLORS[i % WHEEL_COLORS.length];

    ctx.beginPath();
    ctx.moveTo(cx, cy); ctx.arc(cx, cy, r, start, end); ctx.closePath();
    ctx.fillStyle   = color; ctx.fill();
    ctx.strokeStyle = '#080810'; ctx.lineWidth = 2; ctx.stroke();

    ctx.save();
    ctx.translate(cx, cy); ctx.rotate(mid);
    ctx.textAlign   = 'right';
    ctx.fillStyle   = '#fff';
    ctx.font        = `bold ${fontSize}px 'Space Grotesk', sans-serif`;
    ctx.shadowColor = 'rgba(0,0,0,.75)'; ctx.shadowBlur = 4;
    const title = movie.title.length > maxChars ? movie.title.slice(0, maxChars - 1) + '…' : movie.title;
    ctx.fillText(title, r - 14, 5);
    ctx.restore();
  });

  // Outer ring glow
  ctx.beginPath(); ctx.arc(cx, cy, r, 0, 2 * Math.PI);
  ctx.strokeStyle = 'rgba(168,85,247,.5)'; ctx.lineWidth = 3; ctx.stroke();

  // Center hub
  ctx.beginPath(); ctx.arc(cx, cy, 22, 0, 2 * Math.PI);
  ctx.fillStyle = '#080810'; ctx.fill();
  ctx.strokeStyle = '#a855f7'; ctx.lineWidth = 3; ctx.stroke();
  ctx.beginPath(); ctx.arc(cx, cy, 6, 0, 2 * Math.PI);
  ctx.fillStyle = '#a855f7'; ctx.fill();
}

function animateSpin(targetRotation, duration, onComplete) {
  const startRotation = wheelRotation;
  const totalDelta    = targetRotation - startRotation;
  const startTime     = performance.now();

  function tick(now) {
    const t      = Math.min((now - startTime) / duration, 1);
    const eased  = 1 - Math.pow(1 - t, 4); // ease-out quartic
    wheelRotation = startRotation + totalDelta * eased;
    try { drawWheel(wheelMovies, wheelRotation); } catch { /* keep spinning */ }
    if (t < 1) { requestAnimationFrame(tick); }
    else        { wheelRotation = targetRotation; onComplete(); }
  }
  requestAnimationFrame(tick);
}

function showWheelWinner(movie) {
  const overlay = document.getElementById('winner-overlay');
  document.getElementById('winner-title').textContent = movie.title;
  document.getElementById('winner-meta').textContent  =
    [movie.year, movie.duration, movie.rating ? `⭐ ${movie.rating}` : null].filter(Boolean).join(' · ');

  const posterImg = document.getElementById('winner-poster');
  const posterPh  = document.getElementById('winner-poster-ph');
  if (movie.poster) {
    posterImg.onerror = () => {
      posterImg.style.display = 'none';
      posterPh.style.display  = 'flex';
    };
    posterImg.src           = movie.poster; // set src AFTER onerror to avoid missing the event
    posterImg.style.display = 'block';
    posterPh.style.display  = 'none';
  } else {
    posterImg.style.display = 'none';
    posterPh.style.display  = 'flex';
  }
  overlay.style.display = 'flex';
}

// ── Library setup ─────────────────────────────────────────────
function populateServerSelect(servers) {
  const sel = document.getElementById('select-server');
  sel.innerHTML = servers.map((s, i) => `<option value="${i}">${escHtml(s.name)}</option>`).join('');
}

function populateLibrarySelect(libs) {
  const sel = document.getElementById('select-library');
  sel.innerHTML = libs.map(l => `<option value="${escHtml(l.key)}">${escHtml(l.title)}</option>`).join('');
}

function populateGenreSelect(genres) {
  const sel = document.getElementById('select-genre');
  sel.innerHTML = `<option value="">🎬 All genres</option>` +
    genres.map(g => `<option value="${escHtml(g.fastKey ?? '')}">${escHtml(g.title)}</option>`).join('');
}

function getMaxDurationMs() {
  const mins = parseInt(document.getElementById('select-duration')?.value ?? '0', 10);
  return mins > 0 ? mins * 60000 : 0;
}

function applyDurationFilter(movies, maxMs) {
  if (!maxMs) return movies;
  return movies.filter(m => m.duration > 0 && m.duration <= maxMs);
}

// Returns true when a movie's title strongly suggests it is a sequel /
// later instalment.  Conservative patterns only — we'd rather miss a sequel
// than falsely exclude a standalone film like "1917" or "300".
function isSequel(m) {
  const t = (m.title ?? '').trim();
  return (
    // Ends with Roman numeral II or higher: "Rocky II", "Superman IV"
    /\s+(?:II|III|IV|VI|VII|VIII|IX|X[IVX]*)\s*$/i.test(t) ||
    // Explicit sequel words anywhere: "Part 2", "Chapter 3", "Vol. 2"
    /\b(?:Part|Chapter|Episode|Vol\.?)\s*(?:\d+|[IVX]{2,})\b/i.test(t) ||
    // Ends with a bare 1-2 digit number: "Saw 2", "Alien 3", "Die Hard 2"
    /\s+\d{1,2}\s*$/.test(t) ||
    // 1-2 digit number immediately before a colon: "Terminator 2: Judgment Day"
    /\s+\d{1,2}\s*:/.test(t)
  );
}

// Pick `count` movies, capping franchise/sequel titles at SEQUEL_MAX_RATIO.
// Uses Plex Collection tags to catch subtitle-only sequels ("Endgame", "No Way Home")
// that have no number in the title. First movie from each franchise = non-sequel;
// all subsequent movies from the same franchise = sequel.
// Slack propagates both ways so we always fill the pool as much as possible.
function pickMovies(movies, count) {
  const maxSeq          = Math.floor(count * SEQUEL_MAX_RATIO);
  const shuffled        = shuffle(movies);
  const seenCollections = new Set();
  const nonSeq          = [];
  const seqList         = [];

  for (const m of shuffled) {
    const collections   = (m.Collection ?? []).map(c => c.tag).filter(Boolean);
    const collectionHit = collections.some(tag => seenCollections.has(tag));

    if (isSequel(m) || collectionHit) {
      seqList.push(m);
    } else {
      nonSeq.push(m);
      collections.forEach(tag => seenCollections.add(tag));
    }
  }

  const nsSlice  = Math.min(nonSeq.length, count - maxSeq);
  const slackNs  = (count - maxSeq) - nsSlice;
  const seqSlice = Math.min(seqList.length, maxSeq + slackNs);
  const slackSeq = (maxSeq + slackNs) - seqSlice;
  const nsExtra  = Math.min(nonSeq.length - nsSlice, slackSeq);

  return [
    ...nonSeq.slice(0, nsSlice),
    ...seqList.slice(0, seqSlice),
    ...nonSeq.slice(nsSlice, nsSlice + nsExtra),
  ].slice(0, count);
}

async function refreshMovieCount(sectionKey, genreFastKey) {
  const hint = document.getElementById('movie-count-hint');
  try {
    const all     = await plexGetMovies(state.plexServerUri, sectionKey, genreFastKey || null, state.plexToken);
    const movies  = applyDurationFilter(all, getMaxDurationMs());
    const n    = movies.length;
    const pick = Math.min(n, MOVIES_COUNT);
    hint.textContent = n > 0
      ? `${n} movie${n !== 1 ? 's' : ''} available · picking ${pick} at random`
      : 'No movies found for that selection.';
  } catch {
    hint.textContent = '';
  }
}

// ── Utility ────────────────────────────────────────────────────
function escHtml(str) {
  return String(str ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ── Init ──────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  if (!initFirebase()) {
    showScreen('screen-setup-needed');
    return;
  }

  // Wire ALL handlers first — this must run regardless of whether
  // we're doing a fresh start or recovering from a page reload.
  wireAllHandlers();

  // Recover an in-progress session after a page reload.
  // Use a one-shot read to route to the correct screen exactly once, then
  // hand off to onSessionUpdate (which has proper activeScreen guards) for all
  // subsequent changes.  The old approach used a persistent anonymous listener
  // that called startSwiping() on every Firebase update, resetting swipe
  // progress whenever a participant joined mid-session.
  const savedCode = sessionStorage.getItem('pf_session');
  const savedRole = sessionStorage.getItem('pf_role');
  if (savedCode && savedRole) {
    state.role        = savedRole;
    state.sessionCode = savedCode;
    db.ref(`sessions/${savedCode}`).once('value', snap => {
      const session = snap.val();
      if (!session) { clearSession(); return; }
      state.movies = session.movies ?? [];
      if (session.status === 'lobby') {
        showLobby(savedCode, savedRole === 'host');
        // showLobby already calls fbListen(onSessionUpdate)
        return;
      }
      if (session.status === 'swiping') {
        const myEntry = session.participants?.[state.userId];
        if (myEntry?.done) {
          showScreen('screen-waiting');
          updateWaitingProgress(session.participants);
        } else {
          startSwiping();
        }
        // Hand off to normal listener — onSessionUpdate won't re-call startSwiping()
        // because it only does so when transitioning FROM screen-lobby.
        sessionUnsubscribe = fbListen(`sessions/${savedCode}`, onSessionUpdate);
        return;
      }
      if (session.status === 'done') { showResults(session); return; }
      clearSession();
    });
    return;
  }

  showScreen('screen-landing');
});

function wireAllHandlers() {
  // ── Landing ──
  document.getElementById('btn-start-session').onclick = () => {
    state.role = 'host';
    showScreen('screen-auth');
    document.getElementById('host-name-input').focus();
  };

  document.getElementById('btn-join-session').onclick = () => {
    const code = document.getElementById('join-code-input').value.trim().toUpperCase();
    if (code.length !== 6) { toast('Enter a valid session code', 'error'); return; }
    state.sessionCode = code;
    state.role = 'guest';
    showScreen('screen-join-name');
    document.getElementById('guest-name-input').focus();
  };

  document.getElementById('join-code-input').addEventListener('keydown', e => {
    if (e.key === 'Enter') document.getElementById('btn-join-session').click();
  });

  // ── Back buttons ──
  document.getElementById('btn-back-auth').onclick = () => showScreen('screen-landing');
  document.getElementById('btn-back-join').onclick = () => showScreen('screen-landing');

  // ── Guest name + join ──
  document.getElementById('btn-join-confirm').onclick = async () => {
    const name = document.getElementById('guest-name-input').value.trim();
    if (!name) { toast('Enter your name first', 'error'); return; }
    state.userName = name;
    setBtn('btn-join-confirm', true);
    try {
      await joinSession(state.sessionCode);
      sessionStorage.setItem('pf_session', state.sessionCode);
      sessionStorage.setItem('pf_role', 'guest');
      showLobby(state.sessionCode, false);
    } catch (e) {
      toast(e.message, 'error');
    } finally {
      setBtn('btn-join-confirm', false, 'Join Session →');
    }
  };

  document.getElementById('guest-name-input').addEventListener('keydown', e => {
    if (e.key === 'Enter') document.getElementById('btn-join-confirm').click();
  });

  // ── Plex auth ──
  document.getElementById('btn-connect-plex').onclick = async () => {
    const name = document.getElementById('host-name-input').value.trim() || 'Host';
    state.userName = name;
    setBtn('btn-connect-plex', true);

    const statusEl   = document.getElementById('auth-status');
    const statusText = document.getElementById('auth-status-text');
    statusEl.style.display = 'flex';
    statusEl.className     = 'auth-status';
    statusText.textContent = 'Creating PIN…';

    try {
      const pin = await plexCreatePin();
      statusText.textContent = 'Waiting for Plex sign-in…';
      const popup = openPlexAuth(pin.code);

      const token = await pollPin(pin.id);
      if (popup && !popup.closed) popup.close();

      state.plexToken = token;
      sessionStorage.setItem('pf_token', token); // temp — session only

      statusEl.className = 'auth-status success';
      statusEl.innerHTML = '✅ Plex connected! Loading libraries…';

      const servers = await plexGetServers(token);
      if (!servers.length) throw new Error('No Plex servers found on your account.');
      state.plexServers = servers;

      showScreen('screen-library');
      const loading = document.getElementById('library-loading');
      const form    = document.getElementById('library-form');
      loading.style.display = 'flex';
      form.style.display    = 'none';

      populateServerSelect(servers);
      const { apiUri, imageUri } = await bestUri(servers[0], token);
      state.plexServerUri  = apiUri;
      state.plexImageUri   = imageUri;

      const libs = await plexGetLibraries(state.plexServerUri, token);
      if (!libs.length) throw new Error('No movie libraries found on this server.');
      state.plexLibrary = libs[0];
      populateLibrarySelect(libs);

      const genres = await plexGetGenres(state.plexServerUri, libs[0].key, token);
      populateGenreSelect(genres);
      await refreshMovieCount(libs[0].key, '');

      loading.style.display    = 'none';
      form.style.display       = 'flex';
      form.style.flexDirection = 'column';

      wireLibraryForm(servers, libs);
    } catch (e) {
      toast(e.message, 'error');
      statusEl.style.display = 'none';
      setBtn('btn-connect-plex', false,
        `<svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><path d="M11.09 2.16L4.5 7.43v9.14l6.59 5.27 6.59-5.27V7.43L11.09 2.16zm4.34 12.59l-4.34 3.47-4.34-3.47V9.25l4.34-3.47 4.34 3.47v5.5z"/></svg> Connect with Plex`);
    }
  };

  // ── Lobby code copy ──
  document.getElementById('lobby-code').addEventListener('click', async () => {
    const code = state.sessionCode;
    if (!code) return;
    try {
      await navigator.clipboard.writeText(code);
      document.getElementById('copy-hint').textContent = 'Copied!';
      setTimeout(() => { document.getElementById('copy-hint').textContent = 'Tap to copy · Share with friends'; }, 2000);
    } catch { /* clipboard not available */ }
  });

  // ── Start swiping (host) ──
  document.getElementById('btn-start-swiping').onclick = async () => {
    setBtn('btn-start-swiping', true);
    try {
      await fbUpdate(`sessions/${state.sessionCode}`, { status: 'swiping' });
      // onSessionUpdate fires for everyone and calls startSwiping()
    } catch (e) {
      toast('Could not start session. Try again.', 'error');
      setBtn('btn-start-swiping', false, '🎬 Start Swiping');
    }
  };

  // ── Swipe buttons ──
  document.getElementById('btn-nope').onclick = () => triggerSwipe(false);
  document.getElementById('btn-like').onclick = () => triggerSwipe(true);

  // ── Keyboard shortcuts ──
  document.addEventListener('keydown', e => {
    const active = document.querySelector('.screen.active')?.id;
    if (active !== 'screen-swipe') return;
    if (e.key === 'ArrowLeft')  triggerSwipe(false);
    if (e.key === 'ArrowRight') triggerSwipe(true);
  });

  // ── Results ──
  document.getElementById('btn-play-again').onclick = () => {
    if (state.role === 'host') {
      showScreen('screen-library');
    } else {
      toast('Ask the host to start a new set.', 'info');
    }
  };
  document.getElementById('btn-leave-session').onclick = clearSession;

  // ── Wheel ──
  document.getElementById('btn-spin').onclick = async () => {
    if (wheelAnimating || wheelMovies.length <= 1) return;
    // Double-check it's actually this player's turn from the latest Firebase state
    if (_latestWheelData) {
      const { turnOrder = [], spinIndex = 0 } = _latestWheelData;
      const currentTurn = Array.isArray(turnOrder) ? turnOrder : Object.values(turnOrder);
      const expected = currentTurn[spinIndex % currentTurn.length];
      if (expected?.userId !== state.userId) return;
    }
    const n          = wheelMovies.length;
    const elimIdx    = Math.floor(Math.random() * n);
    const eliminateId = wheelMovies[elimIdx].id;
    // Compute target angle so the pointer lands on segment elimIdx
    const sliceAngle = (2 * Math.PI) / n;
    const offset     = 0.2 + Math.random() * 0.6; // random spot within segment
    let   finalAngle = -((elimIdx + offset) * sliceAngle);
    finalAngle = ((finalAngle % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
    document.getElementById('btn-spin').disabled = true;
    await fbUpdate(`sessions/${state.sessionCode}/wheel`, {
      pendingSpin: { eliminateId, targetAngle: finalAngle },
    });
  };

  document.getElementById('btn-winner-play-again').onclick = clearSession;
  document.getElementById('btn-winner-leave').onclick      = clearSession;
}

function wireLibraryForm(servers, initialLibs) {
  const serverSel   = document.getElementById('select-server');
  const librarySel  = document.getElementById('select-library');
  const genreSel    = document.getElementById('select-genre');
  const durationSel = document.getElementById('select-duration');

  serverSel.onchange = async () => {
    const idx = parseInt(serverSel.value, 10);
    const server = servers[idx];
    try {
      const { apiUri: newApiUri, imageUri: newImageUri } = await bestUri(server, state.plexToken);
      state.plexServerUri  = newApiUri;
      state.plexImageUri   = newImageUri;
      const libs = await plexGetLibraries(state.plexServerUri, state.plexToken);
      if (!libs.length) { toast('No movie libraries on this server.', 'error'); return; }
      state.plexLibrary = libs[0];
      populateLibrarySelect(libs);
      const genres = await plexGetGenres(state.plexServerUri, libs[0].key, state.plexToken);
      populateGenreSelect(genres);
      await refreshMovieCount(libs[0].key, '');
    } catch (e) { toast(e.message, 'error'); }
  };

  librarySel.onchange = async () => {
    const key   = librarySel.value;
    const title = librarySel.options[librarySel.selectedIndex]?.text ?? '';
    state.plexLibrary = { key, title };
    const genres = await plexGetGenres(state.plexServerUri, key, state.plexToken);
    populateGenreSelect(genres);
    await refreshMovieCount(key, genreSel.value);
  };

  genreSel.onchange = async () => {
    await refreshMovieCount(state.plexLibrary.key, genreSel.value);
  };

  durationSel.onchange = async () => {
    await refreshMovieCount(state.plexLibrary.key, genreSel.value);
  };

  // ── Create session ──
  document.getElementById('btn-create-session').onclick = async () => {
    const sectionKey     = document.getElementById('select-library').value;
    const genreFastKey   = document.getElementById('select-genre').value || null;

    setBtn('btn-create-session', true);
    try {
      const raw        = await plexGetMovies(state.plexServerUri, sectionKey, genreFastKey, state.plexToken);
      const filtered   = applyDurationFilter(raw, getMaxDurationMs());
      if (!filtered.length) throw new Error('No movies found for that selection. Try adjusting the genre or duration filter.');

      const picked     = pickMovies(filtered, MOVIES_COUNT);
      // Fetch TMDB poster URLs in parallel for all picked movies.
      // Falls back to Plex relay URL per-movie if TMDB is unconfigured or lookup fails.
      const tmdbPosters = await fetchTmdbPosters(picked);
      state.movies  = picked.map(m => formatMovie(
        m, state.plexImageUri, state.plexToken, tmdbPosters[String(m.ratingKey)] ?? null
      ));

      const code    = await createSession(state.movies);
      state.sessionCode = code;

      showLobby(code, true);
      document.getElementById('lobby-movie-info').textContent =
        `${state.movies.length} movies · ${state.plexLibrary?.title ?? 'your library'}`;
    } catch (e) {
      toast(e.message, 'error');
    } finally {
      setBtn('btn-create-session', false, '🚀 Create Session');
    }
  };
}

function clearSession() {
  if (sessionUnsubscribe) { sessionUnsubscribe(); sessionUnsubscribe = null; }
  if (wheelUnsubscribe) { wheelUnsubscribe(); wheelUnsubscribe = null; }
  wheelMovies         = [];
  wheelRotation       = 0;
  wheelAnimating      = false;
  _latestWheelData    = null;
  _lastAnimatedSpinId = null;
  const overlay = document.getElementById('winner-overlay');
  if (overlay) overlay.style.display = 'none';
  sessionStorage.removeItem('pf_session');
  sessionStorage.removeItem('pf_role');
  sessionStorage.removeItem('pf_token');
  state.sessionCode = null;
  state.movies      = [];
  state.swipes      = {};
  state.currentIdx  = 0;
  showScreen('screen-landing');
}
