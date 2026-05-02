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
let _watchdogClearedAt  = 0;     // last time the watchdog cleared a stale pendingSpin (cooldown)

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
  movies:        [],
  swipes:        {},     // { movieId: true|false }
  currentIdx:    0,
  excludedGenres: new Set(),
  aiMode:        false,  // true when session was created with AI movie picker
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

// Firebase removes empty arrays ([] → null) and may return sequential objects
// instead of arrays ({0:"Action"} instead of ["Action"]).  Call this on every
// movie array read back from Firebase before it reaches the UI.
function normaliseMoviesFromFirebase(movies) {
  return (movies ?? []).map(m => ({
    ...m,
    genres: Array.isArray(m.genres) ? m.genres : Object.values(m.genres ?? {}),
  }));
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
  // Warn the host if no relay was reachable — TMDB will mostly cover guests
  // but movies without a tmdb:// guid will fall back to this URL and fail.
  if (!firstWorkingRelay && !anyRelay) {
    toast('No Plex relay found — posters without TMDB matches may not load.', 'error');
  }
  return { apiUri, imageUri };
}

async function plexGetLibraries(uri, token) {
  const r = await fetch(`${uri}/library/sections`, { headers: plexHeaders(token) });
  if (r.status === 401) throw new Error('PLEX_AUTH_EXPIRED');
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
  if (r.status === 401) throw new Error('PLEX_AUTH_EXPIRED');
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
    ? `${plexUri}${m.thumb}?X-Plex-Token=${token}&width=200&height=300`
    : null;
  const tmdbId = rawTmdbId(m);
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
    inLibrary:     true,
    tmdbId,
  };
}

function rawTmdbId(m) {
  const tmdbGuid = (m.Guid ?? []).find(g => g.id?.startsWith('tmdb://'));
  const parsed = tmdbGuid ? Number.parseInt(tmdbGuid.id.slice('tmdb://'.length), 10) : null;
  return Number.isFinite(parsed) ? parsed : null;
}

// ── Session helpers ───────────────────────────────────────────
async function createSession(movies, aiMode = false) {
  const code = generateCode();
  const session = {
    hostId:    state.userId,
    createdAt: Date.now(),
    status:    'lobby',
    aiMode:    aiMode || null, // null keeps Firebase clean when not in AI mode
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
function showLobby(code, isHost, aiMode = false) {
  state.sessionCode = code;
  state.aiMode      = !!aiMode;
  sessionStorage.setItem('pf_session', code);
  sessionStorage.setItem('pf_role', state.role);

  document.getElementById('lobby-code').textContent = code;

  // Show/hide host actions; swap buttons depending on mode
  if (isHost) {
    document.getElementById('lobby-host-actions').style.display = '';
    document.getElementById('btn-start-swiping').style.display   = aiMode ? 'none' : '';
    document.getElementById('btn-ai-find-movies').style.display  = aiMode ? '' : 'none';
  } else {
    document.getElementById('lobby-host-actions').style.display = 'none';
  }

  document.getElementById('lobby-guest-wait').style.display = isHost ? 'none' : '';

  // Show AI description section when session uses AI mode
  const aiSection = document.getElementById('ai-lobby-section');
  if (aiSection) aiSection.style.display = aiMode ? '' : 'none';

  showScreen('screen-lobby');

  sessionUnsubscribe = fbListen(`sessions/${code}`, onSessionUpdate);
}

function updateLobbyParticipants(participants) {
  const list  = document.getElementById('participant-list');
  const count = document.getElementById('participant-count');
  const entries = Object.values(participants ?? {}).filter(Boolean);
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

  if (activeScreen === 'screen-lobby') {
    updateLobbyParticipants(session.participants);
    if (session.aiMode) updateAiDescriptionStatus(session.participants, session.aiDescriptions, session.aiStatus);
  }

  // AI replay: host can send everyone back to the AI lobby to update
  // preferences or rerun the model. This must be Firebase-driven so guests
  // do not remain stranded on results or the wheel.
  if (session.aiMode && session.status === 'lobby' && activeScreen !== 'screen-lobby') {
    const overlay = document.getElementById('winner-overlay');
    if (overlay) overlay.style.display = 'none';
    wheelMovies = []; wheelRotation = 0; wheelAnimating = false;
    _latestWheelData = null; _lastAnimatedSpinId = null;
    if (wheelUnsubscribe) { wheelUnsubscribe(); wheelUnsubscribe = null; }
    state.movies = normaliseMoviesFromFirebase(session.movies);
    state.swipes = {};
    state.currentIdx = 0;
    clearSwipeProgress();
    showLobby(state.sessionCode, state.role === 'host', true);
    return;
  }

  // Lobby → swiping transition (host clicked Start)
  if (session.status === 'swiping' && activeScreen === 'screen-lobby') {
    state.movies = normaliseMoviesFromFirebase(session.movies);
    startSwiping();
    return;
  }

  // Results/wheel → swiping (host kicked off another round in the same session
  // via "Pick Another Set"). Wipe local wheel state and restart swiping with
  // the fresh movie pool the host wrote to Firebase.
  if (session.status === 'swiping' &&
      (activeScreen === 'screen-results' || activeScreen === 'screen-wheel')) {
    const overlay = document.getElementById('winner-overlay');
    if (overlay) overlay.style.display = 'none';
    wheelMovies = []; wheelRotation = 0; wheelAnimating = false;
    _latestWheelData = null; _lastAnimatedSpinId = null;
    if (wheelUnsubscribe) { wheelUnsubscribe(); wheelUnsubscribe = null; }
    state.movies     = normaliseMoviesFromFirebase(session.movies);
    state.swipes     = {};
    state.currentIdx = 0;
    clearSwipeProgress();
    startSwiping();
    return;
  }

  // All logic from the waiting screen — only transition to results from here
  // so a stale listener on screen-library / screen-landing never fires showResults.
  if (activeScreen === 'screen-waiting') {
    updateWaitingProgress(session.participants);

    if (session.status === 'done') {
      showResults(session);
      return;
    }

    // Host sets status=done once every participant has finished swiping
    const parts   = Object.values(session.participants ?? {}).filter(Boolean);
    const allDone = parts.length > 0 && parts.every(p => p.done);
    if (allDone && state.role === 'host') {
      fbUpdate(`sessions/${state.sessionCode}`, { status: 'done' });
    }
  }
}

// ── Swipe UI ─────────────────────────────────────────────────
// Persist swipe progress so a refresh (or a poster-induced lockup) doesn't
// throw away the user's votes. Shuffled movie order is saved too — without
// it a refresh would re-shuffle and the saved currentIdx would point at a
// different movie than the user actually saw.
function persistSwipeProgress() {
  try {
    sessionStorage.setItem('pf_movies', JSON.stringify(state.movies));
    sessionStorage.setItem('pf_swipes', JSON.stringify(state.swipes));
    sessionStorage.setItem('pf_idx',    String(state.currentIdx));
  } catch { /* storage full or disabled — best-effort */ }
}
function clearSwipeProgress() {
  sessionStorage.removeItem('pf_movies');
  sessionStorage.removeItem('pf_swipes');
  sessionStorage.removeItem('pf_idx');
}

function startSwiping() {
  state.currentIdx = 0;
  state.swipes = {};
  state.movies = shuffle(state.movies);
  persistSwipeProgress();
  resumeSwiping();
}

function resumeSwiping() {
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
    ? `<img src="${movie.poster}" alt="${escHtml(movie.title)}" onerror="this.style.display='none';this.closest('.card-poster').querySelector('.poster-placeholder').style.display='flex'">`
    : '';
  const metaParts = [movie.year, movie.duration, movie.rating ? `⭐ ${movie.rating}` : null].filter(Boolean);
  const badge = movie.contentRating ? `<span class="badge">${escHtml(movie.contentRating)}</span>` : '';
  const notInLib = movie.inLibrary === false
    ? `<span class="not-in-library-chip">📥 Not in library</span>`
    : '';
  const genreList = movie.genres ?? [];
  const genres = genreList.length
    ? `<div class="genre-tags">${genreList.map(g => `<span class="genre-tag">${escHtml(g)}</span>`).join('')}</div>`
    : '';

  const placeholderHtml = `
    <div class="poster-placeholder" style="display:${movie.poster ? 'none' : 'flex'}">
      <div class="ph-icon">🎬</div>
      <div class="ph-title">${escHtml(movie.title)}</div>
      ${movie.year ? `<div class="ph-meta">${escHtml(movie.year)}</div>` : ''}
    </div>`;
  card.innerHTML = `
    <div class="card-poster">
      ${posterHtml}
      ${placeholderHtml}
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
          ${badge}${notInLib}
        </div>
      </div>
      ${movie.summary ? `<p class="card-summary">${escHtml(movie.summary)}</p>` : ''}
      ${genres}
    </div>`;
  return card;
}

function attachDrag(card, movieId) {
  let startX = 0, startY = 0, curX = 0, curY = 0, pointerId = null;

  const overlay = card.querySelector('.card-color-overlay');
  const stampL  = card.querySelector('.stamp-like');
  const stampN  = card.querySelector('.stamp-nope');

  function snapBack() {
    card.style.transition = 'transform .35s ease';
    card.style.transform  = 'scale(1) translateY(0)';
    stampL.style.opacity  = 0;
    stampN.style.opacity  = 0;
    overlay.style.background = 'transparent';
  }

  card.addEventListener('pointerdown', e => {
    if (pointerId !== null || e.button > 0) return;
    e.preventDefault();
    pointerId = e.pointerId;
    startX = e.clientX; startY = e.clientY; curX = 0; curY = 0;
    card.setPointerCapture(e.pointerId);
    card.style.transition = 'none';
  });

  card.addEventListener('pointermove', e => {
    if (e.pointerId !== pointerId) return;
    curX = e.clientX - startX; curY = e.clientY - startY;
    const rot = curX * 0.07;
    card.style.transform = `translateX(${curX}px) translateY(${curY}px) rotate(${rot}deg)`;
    const likeAmt = Math.min(Math.max(curX  / 100, 0), 1);
    const nopeAmt = Math.min(Math.max(-curX / 100, 0), 1);
    stampL.style.opacity = likeAmt;
    stampN.style.opacity = nopeAmt;
    overlay.style.background = curX > 0
      ? `rgba(74,222,128,${likeAmt * 0.28})`
      : `rgba(248,113,113,${nopeAmt * 0.28})`;
  });

  card.addEventListener('pointerup', e => {
    if (e.pointerId !== pointerId) return;
    pointerId = null;
    if (Math.abs(curX) > 90) flyOff(card, curX > 0, movieId);
    else snapBack();
  });

  // iOS/system can cancel a touch mid-drag (edge swipe, incoming call, etc.)
  // Without this, the card gets stuck mid-transform and subsequent drags break.
  card.addEventListener('pointercancel', e => {
    if (e.pointerId !== pointerId) return;
    pointerId = null;
    snapBack();
  });
}

function flyOff(card, liked, movieId) {
  if (card.dataset.flying) return; // guard: rapid taps must not double-record
  card.dataset.flying = '1';
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
  persistSwipeProgress();
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
    clearSwipeProgress(); // swipes safely in Firebase — local cache no longer needed
  } catch (e) {
    toast('Error saving swipes — check your connection.', 'error');
    // Keep the local cache so the user can recover and retry on refresh
  }
  // Keep listening; onSessionUpdate will fire when all done
}

function updateWaitingProgress(participants) {
  const list = document.getElementById('waiting-participant-list');
  list.innerHTML = Object.values(participants ?? {}).filter(Boolean).map(p => `
    <div class="chip">
      <div class="dot ${p.done ? 'done' : 'waiting'}"></div>
      ${escHtml(p.name)} ${p.done ? '✓' : '…'}
    </div>`).join('');
}

// ── Results ───────────────────────────────────────────────────
function showResults(session) {
  const movies       = normaliseMoviesFromFirebase(session.movies);
  const allSwipes    = session.swipes ?? {};
  const participants = session.participants ?? {};
  const pCount       = Object.keys(participants).length;

  const matches = movies
    .map(movie => {
      const yesVotes = Object.values(allSwipes).filter(u => u && u[movie.id] === true).length;
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
    const notInLib = movie.inLibrary === false
      ? `<span class="not-in-library-chip" style="margin-top:4px;display:inline-block">📥 Not in library</span>`
      : '';
    list.innerHTML = `
      <div class="result-item">
        ${movie.poster
          ? `<img class="result-poster" src="${movie.poster}" alt="${escHtml(movie.title)}" loading="lazy" onerror="this.style.display='none';this.nextElementSibling.style.display='flex'"><div class="result-poster-placeholder" style="display:none">🎬</div>`
          : `<div class="result-poster-placeholder">🎬</div>`}
        <div style="flex:1;min-width:0">
          <div style="font-weight:700;font-size:16px;margin-bottom:2px">${escHtml(movie.title)}</div>
          <div class="text-muted" style="font-size:13px">${[movie.year, movie.duration].filter(Boolean).join(' · ')}</div>
          ${(movie.genres ?? []).length ? `<div class="genre-tags" style="margin-top:4px">${movie.genres.map(g => `<span class="genre-tag">${escHtml(g)}</span>`).join('')}</div>` : ''}
          ${notInLib}
        </div>
        <div class="match-pct">${yesVotes}/${pCount}</div>
      </div>`;
    // Radarr download button for non-library winner
    if (movie.inLibrary === false && movie.tmdbId) {
      const { url, key } = getRadarrConfig();
      if (isBridgeMode() || (url && key)) {
        const radarrWrap = document.createElement('div');
        radarrWrap.className = 'mt-3';
        const radarrBtn = document.createElement('button');
        radarrBtn.className   = 'btn btn-secondary';
        radarrBtn.textContent = '📥 Add to Radarr';
        radarrBtn.onclick = async () => {
          radarrBtn.disabled  = true;
          radarrBtn.innerHTML = '<span class="spinner-sm"></span>';
          try {
            const res = await addToRadarr(movie);
            radarrBtn.textContent = res.alreadyExists ? '✅ Already in Radarr' : '✅ Added to Radarr!';
          } catch (e) {
            toast(e.message, 'error');
            radarrBtn.disabled  = false;
            radarrBtn.textContent = '📥 Add to Radarr';
          }
        };
        radarrWrap.appendChild(radarrBtn);
        list.appendChild(radarrWrap);
      }
    }
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

  // Stale-spin recovery: if pendingSpin has been stuck for >15s (animation is
  // 4.2s, so this is ~3.5x), the spinner likely closed their tab mid-spin or
  // their network died. Any client clears it; Firebase merges idempotent writes.
  // 5s cooldown after a clear prevents racing with a successful commit that's
  // still in-flight (commit also nulls pendingSpin, so a duplicate clear is OK,
  // but the cooldown stops every client from spamming the same write).
  const watchdogCooldown = Date.now() - _watchdogClearedAt < 5000;
  if (pendingSpin?.startedAt && Date.now() - pendingSpin.startedAt > 15000 && !wheelAnimating && !watchdogCooldown) {
    _watchdogClearedAt  = Date.now();
    _lastAnimatedSpinId = null;
    fbUpdate(`sessions/${state.sessionCode}/wheel`, { pendingSpin: null }).catch(() => {});
    return;
  }

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
        // Guard: skip if the Firebase state has already advanced past this spin,
        // OR if the latest snapshot says someone else is the spinner now (handles
        // the case where wheel state diverged across clients).
        const latestTurnOrder = Array.isArray(_latestWheelData?.turnOrder)
          ? _latestWheelData.turnOrder
          : Object.values(_latestWheelData?.turnOrder ?? {});
        const latestSpinner = latestTurnOrder[spinIndex % (latestTurnOrder.length || 1)] ?? {};
        if (currentTurn.userId === state.userId &&
            (_latestWheelData?.spinIndex ?? spinIndex) === spinIndex &&
            latestSpinner.userId === state.userId) {
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
    posterImg.src           = movie.poster;
    posterImg.style.display = 'block';
    posterPh.style.display  = 'none';
  } else {
    posterImg.style.display = 'none';
    posterPh.style.display  = 'flex';
  }

  // Show Radarr download button if movie isn't in the library and Radarr is configured
  wireWinnerRadarrBtn(movie);

  overlay.style.display = 'flex';
}

function wireWinnerRadarrBtn(movie) {
  const btn = document.getElementById('btn-winner-radarr');
  if (!btn) return;
  const { url, key } = getRadarrConfig();
  if (movie.inLibrary === false && movie.tmdbId && (isBridgeMode() || (url && key))) {
    btn.style.display = '';
    btn.disabled      = false;
    btn.textContent   = '📥 Add to Radarr';
    btn.onclick = async () => {
      btn.disabled  = true;
      btn.innerHTML = '<span class="spinner-sm"></span>';
      try {
        const res = await addToRadarr(movie);
        btn.textContent = res.alreadyExists ? '✅ Already in Radarr' : '✅ Added to Radarr!';
      } catch (e) {
        toast(e.message, 'error');
        btn.disabled  = false;
        btn.textContent = '📥 Add to Radarr';
      }
    };
  } else {
    btn.style.display = 'none';
  }
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

  state.excludedGenres.clear();
  const chipsEl = document.getElementById('exclude-genre-chips');
  const group   = document.getElementById('exclude-genre-group');
  if (!chipsEl) return;
  chipsEl.innerHTML = genres.map(g =>
    `<button type="button" class="genre-chip" data-genre="${escHtml(g.title)}">${escHtml(g.title)}</button>`
  ).join('');
  group.style.display = genres.length ? '' : 'none';
  chipsEl.querySelectorAll('.genre-chip').forEach(chip => {
    chip.addEventListener('click', async () => {
      const title = chip.dataset.genre;
      if (state.excludedGenres.has(title)) {
        state.excludedGenres.delete(title);
        chip.classList.remove('excluded');
      } else {
        state.excludedGenres.add(title);
        chip.classList.add('excluded');
      }
      const genreSel = document.getElementById('select-genre');
      await refreshMovieCount(state.plexLibrary.key, genreSel.value);
    });
  });
}

function initYearRangeSelect() {
  const sel = document.getElementById('select-year-range');
  if (!sel) return;
  const cur = new Date().getFullYear();
  const decade = Math.floor(cur / 10) * 10;
  sel.innerHTML = `
    <option value="">📅 Any year</option>
    <option value="${cur - 4}:${cur}">Last 5 years (${cur - 4}–${cur})</option>
    <option value="${cur - 9}:${cur}">Last 10 years (${cur - 9}–${cur})</option>
    <option value="${decade}:${decade + 9}">${decade}s</option>
    <option value="${decade - 10}:${decade - 1}">${decade - 10}s</option>
    <option value="${decade - 20}:${decade - 11}">${decade - 20}s</option>
    <option value="${decade - 30}:${decade - 21}">${decade - 30}s</option>
    <option value="${decade - 40}:${decade - 31}">${decade - 40}s</option>
    <option value="0:${decade - 41}">Before ${decade - 40}</option>
  `;
}

function applyYearFilter(movies) {
  const val = document.getElementById('select-year-range')?.value ?? '';
  if (!val) return movies;
  const [from, to] = val.split(':').map(Number);
  return movies.filter(m => {
    const y = parseInt(m.year, 10);
    if (!y) return true; // no year metadata → don't exclude
    if (from && y < from) return false;
    if (to  && y > to)   return false;
    return true;
  });
}

function getMaxDurationMs() {
  const mins = parseInt(document.getElementById('select-duration')?.value ?? '0', 10);
  return mins > 0 ? mins * 60000 : 0;
}

function applyDurationFilter(movies, maxMs) {
  if (!maxMs) return movies;
  return movies.filter(m => m.duration > 0 && m.duration <= maxMs);
}

function applyExcludeGenreFilter(movies) {
  if (!state.excludedGenres.size) return movies;
  return movies.filter(m => !(m.Genre ?? []).some(g => state.excludedGenres.has(g.tag)));
}

// Conservative sequel detector — only catches explicit numbered/Roman
// follow-ups like "Fox and the Hound 2", "Iron Man 3", "Rocky II",
// "Harry Potter ... Part 2". Subtitle-only sequels ("Avengers: Endgame")
// slip through intentionally — false positives ("9", "300", "1917") are worse.
function isSequel(m) {
  const t = (m.title ?? '').trim();
  return (
    /\s+(?:II|III|IV|VI|VII|VIII|IX|X[IVX]*)\s*$/i.test(t) ||  // Rocky II
    /\s+\d{1,2}\s*$/.test(t) ||                                 // Fox and the Hound 2
    /\b(?:Part|Chapter|Vol\.?)\s+(?:\d+|[IVX]{2,})\b/i.test(t)  // Deathly Hallows: Part 2
  );
}

// Pick `count` movies, hard-filtering obvious numbered sequels.
// Falls back to the unfiltered pool if filtering leaves us short.
function pickMovies(movies, count) {
  const filtered = movies.filter(m => !isSequel(m));
  const pool     = filtered.length >= count ? filtered : movies;
  return shuffle(pool).slice(0, Math.min(count, pool.length));
}

async function refreshMovieCount(sectionKey, genreFastKey) {
  const hint = document.getElementById('movie-count-hint');
  try {
    const all    = await plexGetMovies(state.plexServerUri, sectionKey, genreFastKey || null, state.plexToken);
    const byYear = applyYearFilter(all);
    const byDur  = applyDurationFilter(byYear, getMaxDurationMs());
    const movies = applyExcludeGenreFilter(byDur);
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

// ── AI / LM Studio (Beta) ─────────────────────────────────────
// The LM Studio endpoint is stored in sessionStorage only — it's a local
// network URL that must never leave the host's device or be written to Firebase.

function getLmEndpoint() {
  return sessionStorage.getItem('pf_lm_endpoint') ?? '';
}
function setLmEndpoint(url) {
  if (url) {
    const endpoint = normalizeEndpoint(url);
    if (endpoint !== getLmEndpoint()) setLmModelId('');
    sessionStorage.setItem('pf_lm_endpoint', endpoint);
    return endpoint;
  } else {
    sessionStorage.removeItem('pf_lm_endpoint');
    setLmModelId('');
    return '';
  }
}
function getLmModelId() {
  return sessionStorage.getItem('pf_lm_model_id') ?? '';
}
function setLmModelId(modelId) {
  if (modelId) sessionStorage.setItem('pf_lm_model_id', modelId);
  else sessionStorage.removeItem('pf_lm_model_id');
}
function getAiConnectionMode() {
  return sessionStorage.getItem('pf_ai_connection_mode') || 'bridge';
}
function setAiConnectionMode(mode) {
  sessionStorage.setItem('pf_ai_connection_mode', mode === 'direct' ? 'direct' : 'bridge');
}
function isBridgeMode() {
  return getAiConnectionMode() === 'bridge';
}
function getBridgeUrl() {
  return sessionStorage.getItem('pf_bridge_url') || 'http://127.0.0.1:8765';
}
function setBridgeUrl(url) {
  const normalized = normalizeEndpoint(url || 'http://127.0.0.1:8765');
  sessionStorage.setItem('pf_bridge_url', normalized);
  return normalized;
}
function normalizeEndpoint(url) {
  const raw = String(url || '').trim().replace(/\/$/, '');
  if (!raw) return '';
  return /^https?:\/\//i.test(raw) ? raw : `http://${raw}`;
}

async function bridgeFetch(path, options = {}) {
  const baseUrl = getBridgeUrl();
  if (!baseUrl) throw new Error('PickFlick Bridge URL is required.');
  const r = await fetch(`${baseUrl}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok || data.ok === false) throw new Error(data.error || `Bridge returned HTTP ${r.status}`);
  return data;
}

async function testBridgeConnection(url) {
  const baseUrl = setBridgeUrl(url);
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 6000);
  try {
    const r = await fetch(`${baseUrl}/health`, { signal: ctrl.signal });
    clearTimeout(t);
    const data = await r.json().catch(() => ({}));
    if (!r.ok || data.ok === false) throw new Error(data.error || `HTTP ${r.status}`);
    return data;
  } catch (e) {
    clearTimeout(t);
    if (e.name === 'AbortError') throw new Error('Timed out reaching PickFlick Bridge. Is it running?');
    throw new Error(`Cannot reach PickFlick Bridge: ${e.message}`);
  }
}

async function syncAiStatus(message, running = true) {
  if (!state.sessionCode) return;
  const payload = running
    ? { running: true, message, updatedAt: Date.now() }
    : null;

  await fbUpdate(`sessions/${state.sessionCode}`, { aiStatus: payload }).catch(() => {});
}

function chunkArray(arr, size) {
  const chunks = [];
  for (let i = 0; i < arr.length; i += size) chunks.push(arr.slice(i, i + size));
  return chunks;
}

// ── Radarr integration ────────────────────────────────────────
function getRadarrConfig() {
  return {
    url: sessionStorage.getItem('pf_radarr_url') ?? '',
    key: sessionStorage.getItem('pf_radarr_key') ?? '',
  };
}
function setRadarrConfig(url, key) {
  if (url) sessionStorage.setItem('pf_radarr_url', url.trim().replace(/\/$/, ''));
  else     sessionStorage.removeItem('pf_radarr_url');
  if (key) sessionStorage.setItem('pf_radarr_key', key.trim());
  else     sessionStorage.removeItem('pf_radarr_key');
}

async function testRadarrConnection(url, key) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 6000);
  try {
    const r = await fetch(`${url}/api/v3/system/status`, {
      headers: { 'X-Api-Key': key }, signal: ctrl.signal,
    });
    clearTimeout(t);
    if (r.status === 401) throw new Error('Invalid API key');
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const d = await r.json();
    return { ok: true, version: d.version };
  } catch (e) {
    clearTimeout(t);
    if (e.name === 'AbortError') throw new Error('Connection timed out');
    throw new Error(`Cannot reach Radarr: ${e.message}`);
  }
}

async function addToRadarr(movie) {
  if (isBridgeMode()) {
    const data = await bridgeFetch('/radarr/add', {
      method: 'POST',
      body: JSON.stringify({
        tmdbId: movie.tmdbId,
        title: movie.title,
        year: movie.year,
      }),
    });
    return data.alreadyExists ? { alreadyExists: true } : { added: true };
  }
  const { url, key } = getRadarrConfig();
  if (!url || !key) throw new Error('Radarr not configured — enter URL and API key in the library setup.');
  if (!movie.tmdbId) throw new Error('No TMDB ID for this movie — cannot add to Radarr.');
  const headers = { 'X-Api-Key': key, 'Content-Type': 'application/json' };
  const [rfRes, qpRes] = await Promise.all([
    fetch(`${url}/api/v3/rootfolder`,    { headers }),
    fetch(`${url}/api/v3/qualityprofile`, { headers }),
  ]);
  const rootFolders = rfRes.ok ? await rfRes.json() : [];
  const profiles    = qpRes.ok ? await qpRes.json() : [];
  const rootPath    = rootFolders[0]?.path;
  if (!rootPath) throw new Error('No root folders found in Radarr — check your Radarr setup.');
  const profileId = profiles[0]?.id ?? 1;
  const addRes = await fetch(`${url}/api/v3/movie`, {
    method: 'POST', headers,
    body: JSON.stringify({
      tmdbId:           movie.tmdbId,
      title:            movie.title,
      qualityProfileId: profileId,
      rootFolderPath:   rootPath,
      monitored:        true,
      addOptions:       { searchForMovie: true },
    }),
  });
  if (addRes.status === 400) {
    const errBody = await addRes.json().catch(() => []);
    const msgs    = Array.isArray(errBody) ? errBody.map(e => e.errorMessage) : [errBody.message ?? ''];
    if (msgs.some(m => /already/i.test(m))) return { alreadyExists: true };
    throw new Error(msgs.join(', ') || `Radarr error ${addRes.status}`);
  }
  if (!addRes.ok) throw new Error(`Radarr returned HTTP ${addRes.status}`);
  return { added: true };
}

// TMDB movie search — fetches metadata for AI-suggested non-library films
async function tmdbSearchMovie(title, year) {
  const apiKey = window.tmdbApiKey;
  if (!apiKey || apiKey === 'YOUR_TMDB_API_KEY') return null;
  try {
    const yearParam = year ? `&year=${year}` : '';
    const r = await fetch(
      `https://api.themoviedb.org/3/search/movie?api_key=${apiKey}&query=${encodeURIComponent(title)}${yearParam}&language=en-US&page=1`
    );
    if (!r.ok) return null;
    const d = await r.json();
    const m = d.results?.[0];
    if (!m) return null;
    return {
      tmdbId:  m.id,
      title:   m.title,
      year:    m.release_date?.slice(0, 4) ?? String(year ?? ''),
      summary: (m.overview ?? '').slice(0, 220),
      rating:  m.vote_average ? parseFloat(m.vote_average).toFixed(1) : null,
      poster:  m.poster_path ? `${TMDB_IMAGE_BASE}${m.poster_path}` : null,
    };
  } catch { return null; }
}

function formatSuggestedMovie(tmdbData) {
  return {
    id:            `tmdb:${tmdbData.tmdbId}`,
    title:         tmdbData.title,
    year:          tmdbData.year,
    summary:       tmdbData.summary,
    rating:        tmdbData.rating,
    contentRating: '',
    duration:      '',
    genres:        [],
    poster:        tmdbData.poster,
    inLibrary:     false,
    tmdbId:        tmdbData.tmdbId,
  };
}

async function testLmConnection(endpoint) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 6000);
  try {
    const r = await fetch(`${endpoint}/v1/models`, { signal: ctrl.signal });
    clearTimeout(t);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const d = await r.json();
    return { ok: true, models: d.data ?? [] };
  } catch (e) {
    clearTimeout(t);
    if (e.name === 'AbortError') throw new Error('Timed out — is LM Studio running and reachable from this browser?');
    throw new Error(`Cannot reach LM Studio: ${e.message}. Enable CORS in LM Studio Settings → Server.`);
  }
}

// Build a compact movie catalog for LLM context (id, title, year, genres, short summary).
function buildAiCatalog(rawMovies) {
  return rawMovies.map(m => ({
    id:      String(m.ratingKey),
    t:       m.title ?? '',
    y:       m.year  ?? '',
    g:       (m.Genre ?? []).map(g => g.tag).slice(0, 4),
    s:       (m.summary ?? '').slice(0, 120),
    r:       m.rating ? parseFloat(m.rating).toFixed(1) : null,
    dur:     m.duration ? Math.round(m.duration / 60000) : null,
  }));
}

function buildAiSystemPrompt() {
  return `You are a movie curator helping a group of friends pick movies for their movie night from a Plex library.

You will receive:
1. Each participant's description of what mood, tone, or type of film they want tonight
2. A JSON catalog of movies they already own: id, t=title, y=year, g=genres, s=summary, r=rating, dur=duration in minutes

Your task has TWO parts:

PART 1 — "selected": Pick 20–30 movies from the catalog that best match everyone's preferences.
- Use the exact "id" field from the catalog
- Balance every participant's mood and tone preferences
- Favour variety: mix genres, eras, energy levels when tastes differ

PART 2 — "suggestions": Recommend up to 8 real movies NOT in the catalog that the group would love.
- Draw from your training knowledge of real films
- Match the same mood/vibe the participants described
- Be accurate — only suggest real films with the correct title and year
- These will be offered as Radarr downloads so accuracy matters

CRITICAL: Respond ONLY with valid JSON, no markdown, no code fences, no extra text:
{"selected":["id1","id2",...],"suggestions":[{"title":"Movie Name","year":2019},{"title":"Another Film","year":2015}],"reason":"One sentence"}`;
}

function buildAiUserPrompt(catalog, descriptions) {
  const prefs = Object.values(descriptions)
    .filter(d => d?.text?.trim())
    .map(d => `${d.name}: "${d.text.trim()}"`)
    .join('\n');

  return `WHAT EVERYONE WANTS TONIGHT:\n${prefs}\n\nMOVIES ALREADY IN PLEX:\n${JSON.stringify(catalog)}`;
}

async function callLmStudio(endpoint, modelId, systemPrompt, userPrompt) {
  if (isBridgeMode()) {
    const data = await bridgeFetch('/lm/chat', {
      method: 'POST',
      body: JSON.stringify({ modelId, systemPrompt, userPrompt }),
    });
    return data.content ?? '';
  }
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 90000); // 90s for slow local models
  try {
    const r = await fetch(`${endpoint}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: modelId,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user',   content: userPrompt   },
        ],
        temperature: 0.25,
        max_tokens:  1000,
        stream:      false,
      }),
      signal: ctrl.signal,
    });
    clearTimeout(t);
    if (!r.ok) {
      const body = await r.text().catch(() => '');
      throw new Error(`LM Studio returned HTTP ${r.status}: ${body.slice(0, 200)}`);
    }
    const data = await r.json();
    return data.choices?.[0]?.message?.content ?? '';
  } catch (e) {
    clearTimeout(t);
    if (e.name === 'AbortError') throw new Error('LM Studio took too long (>90s). Try a smaller/faster model or reduce the library size.');
    throw e;
  }
}

function parseLmResponse(text) {
  let t = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '');
  const match = t.match(/\{[\s\S]*\}/);
  if (!match) throw new Error('AI response did not contain JSON. Got: ' + t.slice(0, 300));
  const parsed = JSON.parse(match[0]);
  if (!Array.isArray(parsed.selected)) throw new Error('AI response missing "selected" array. Got: ' + t.slice(0, 300));
  if (!Array.isArray(parsed.suggestions)) parsed.suggestions = [];
  return parsed;
}

async function runChunkedAiSelection(endpoint, modelId, pool, descriptions, setStatus) {
  const catalog = buildAiCatalog(pool);
  const chunks = chunkArray(catalog, 250);
  const selectedIds = new Set();
  const suggestions = [];
  const reasons = [];

  for (let i = 0; i < chunks.length; i++) {
    await setStatus(`Reading library chunk ${i + 1}/${chunks.length} (${chunks[i].length} movies)...`);

    const raw = await callLmStudio(
      endpoint,
      modelId,
      buildAiSystemPrompt(),
      buildAiUserPrompt(chunks[i], descriptions)
    );

    const parsed = parseLmResponse(raw);
    parsed.selected.slice(0, 14).forEach(id => selectedIds.add(String(id)));
    (parsed.suggestions ?? []).slice(0, 8).forEach(s => suggestions.push(s));
    if (parsed.reason) reasons.push(parsed.reason);
  }

  const candidates = catalog.filter(m => selectedIds.has(String(m.id)));

  if (chunks.length <= 1 || candidates.length <= MOVIES_COUNT) {
    return {
      selected: candidates.slice(0, MOVIES_COUNT).map(m => String(m.id)),
      suggestions: suggestions.slice(0, 8),
      reason: reasons[0] ?? 'AI matched the group preferences.',
    };
  }

  await setStatus(`Narrowing ${candidates.length} candidates into the final deck...`);

  const finalRaw = await callLmStudio(
    endpoint,
    modelId,
    buildAiSystemPrompt(),
    buildAiUserPrompt(candidates, descriptions)
  );
  const finalParsed = parseLmResponse(finalRaw);

  return {
    selected: finalParsed.selected,
    suggestions: [...(finalParsed.suggestions ?? []), ...suggestions].slice(0, 8),
    reason: finalParsed.reason ?? reasons[0] ?? 'AI matched the group preferences.',
  };
}

async function runAiPick() {
  return runAiPickHardened();
}

async function runAiPickHardened() {
  if (state.role !== 'host') {
    toast('Waiting for the host to find movies...', 'info');
    return;
  }
  const endpoint = isBridgeMode() ? getBridgeUrl() : getLmEndpoint();
  if (!endpoint) {
    toast(isBridgeMode()
      ? 'PickFlick Bridge URL not set - run the bridge setup first.'
      : 'LM Studio URL not set - configure it in the library setup.', 'error');
    return;
  }
  if (!state.plexLibrary?.key || !state.plexServerUri || !state.plexToken) {
    toast('Plex connection lost - please start a new session.', 'error');
    return;
  }

  const btn = document.getElementById('btn-ai-find-movies');
  const statusEl = document.getElementById('ai-pick-status-text');
  const statusRow = document.getElementById('ai-pick-status-row');
  if (btn) btn.disabled = true;
  if (statusRow) statusRow.style.display = 'flex';

  const setStatus = async msg => {
    if (statusEl) statusEl.textContent = msg;
    await syncAiStatus(msg, true);
  };

  try {
    await setStatus('Reading everyone\'s preferences...');

    const sessionBefore = await fbGet(`sessions/${state.sessionCode}`);
    const participants = Object.values(sessionBefore?.participants ?? {}).filter(Boolean);
    const descriptions = sessionBefore?.aiDescriptions ?? {};
    const descCount = Object.values(descriptions).filter(d => d?.text?.trim()).length;

    if (descCount === 0) {
      throw new Error('Nobody has submitted their preferences yet! Ask participants to describe what they want to watch.');
    }
    if (participants.length > descCount) {
      const ok = confirm(`Only ${descCount}/${participants.length} people submitted preferences. Run AI anyway?`);
      if (!ok) throw new Error('AI pick cancelled - waiting for more preferences.');
    }

    await setStatus(isBridgeMode() ? 'Checking PickFlick Bridge...' : 'Checking LM Studio model...');
    let modelId = getLmModelId();
    if (isBridgeMode()) {
      const health = await testBridgeConnection(endpoint);
      modelId = health.config?.lmStudio?.modelId ?? '';
      if (modelId) setLmModelId(modelId);
    } else if (!modelId) {
      const { models } = await testLmConnection(endpoint);
      modelId = models[0]?.id ?? '';
      if (modelId) setLmModelId(modelId);
    }
    if (!modelId) {
      throw new Error(isBridgeMode()
        ? 'No LM Studio model is selected in PickFlick Bridge. Open bridge setup, test LM Studio, choose a model, and save.'
        : 'No LM Studio model is loaded. Load a model, test the connection, and try again.');
    }

    await setStatus('Fetching your Plex library...');
    const rawAll = await plexGetMovies(state.plexServerUri, state.plexLibrary.key, null, state.plexToken);
    const byYear = applyYearFilter(rawAll);
    const pool = applyDurationFilter(byYear, getMaxDurationMs());

    if (!pool.length) throw new Error('No movies available with current filters. Adjust year/duration and try again.');

    await setStatus(`Asking AI to pick from ${pool.length} movies based on ${descCount} preference${descCount !== 1 ? 's' : ''}...`);
    const parsed = await runChunkedAiSelection(endpoint, modelId, pool, descriptions, setStatus);
    const selected = new Set(parsed.selected.map(String));

    await setStatus('AI picked. Fetching metadata and posters...');
    let pickedRaw = pool.filter(m => selected.has(String(m.ratingKey)));

    const aiMatchedCount = pickedRaw.length;
    if (pickedRaw.length < 5) {
      const extras = shuffle(pool.filter(m => !selected.has(String(m.ratingKey))));
      pickedRaw = [...pickedRaw, ...extras].slice(0, MOVIES_COUNT);
      toast(`AI matched ${aiMatchedCount} library film${aiMatchedCount !== 1 ? 's' : ''} - padded to fill the deck.`, 'info');
    } else {
      pickedRaw = pickedRaw.slice(0, MOVIES_COUNT);
    }

    const tmdbPosters = await fetchTmdbPosters(pickedRaw);
    const libraryMovies = pickedRaw.map(m => formatMovie(
      m, state.plexImageUri, state.plexToken, tmdbPosters[String(m.ratingKey)] ?? null
    ));

    const existingTitles = new Set(pool.map(m => (m.title ?? '').toLowerCase()));
    const existingTmdbIds = new Set(pool.map(rawTmdbId).filter(id => id !== null));
    const suggestionsSeen = new Set();
    const suggestionsRaw = (parsed.suggestions ?? [])
      .filter(s => {
        const key = `${String(s?.title || '').trim().toLowerCase()}|${String(s?.year || '').trim()}`;
        if (!s?.title || suggestionsSeen.has(key)) return false;
        suggestionsSeen.add(key);
        return true;
      })
      .slice(0, 8);
    const suggestionsResolved = await Promise.allSettled(
      suggestionsRaw
        .filter(s => !existingTitles.has((s.title ?? '').trim().toLowerCase()))
        .map(s => tmdbSearchMovie(s.title, s.year))
    );
    const suggestedTmdbIds = new Set();
    const suggestedMovies = suggestionsResolved
      .filter(r => r.status === 'fulfilled' && r.value && !existingTmdbIds.has(r.value.tmdbId))
      .filter(r => {
        if (suggestedTmdbIds.has(r.value.tmdbId)) return false;
        suggestedTmdbIds.add(r.value.tmdbId);
        return true;
      })
      .map(r => formatSuggestedMovie(r.value));

    const newMovies = [...libraryMovies, ...suggestedMovies];
    if (parsed.reason) toast(`AI: ${parsed.reason}`, 'info');

    const session = await fbGet(`sessions/${state.sessionCode}`);
    const updates = {
      [`sessions/${state.sessionCode}/movies`]: newMovies,
      [`sessions/${state.sessionCode}/swipes`]: null,
      [`sessions/${state.sessionCode}/wheel`]: null,
      [`sessions/${state.sessionCode}/aiStatus`]: null,
      [`sessions/${state.sessionCode}/status`]: 'swiping',
    };
    Object.keys(session?.participants ?? {}).forEach(uid => {
      updates[`sessions/${state.sessionCode}/participants/${uid}/done`] = false;
    });
    await db.ref('/').update(updates);
  } catch (e) {
    await syncAiStatus(e.message, false);
    if (statusRow) statusRow.style.display = 'none';
    if (btn) btn.disabled = false;
    toast(e.message, 'error');
  }
}

function updateAiDescriptionStatus(participants, descriptions, aiStatus = null) {
  const statusList = document.getElementById('ai-desc-status-list');
  const statusDiv  = document.getElementById('ai-desc-status');
  const statusRow  = document.getElementById('ai-pick-status-row');
  const statusText = document.getElementById('ai-pick-status-text');
  const aiBtn      = document.getElementById('btn-ai-find-movies');
  if (!statusList || !statusDiv) return;
  const parts = Object.entries(participants ?? {}).filter(([, p]) => p);
  if (!parts.length) { statusDiv.style.display = 'none'; return; }
  const descs = descriptions ?? {};
  const submittedCount = parts.filter(([uid]) => !!descs[uid]?.text?.trim()).length;
  statusList.innerHTML = parts.map(([uid, p]) => {
    const submitted = !!descs[uid]?.text?.trim();
    return `<div class="chip">
      <div class="dot ${submitted ? 'done' : 'waiting'}"></div>
      ${escHtml(p.name)}${submitted ? ' ✓' : ' …'}
    </div>`;
  }).join('');
  statusDiv.style.display = '';

  if (aiBtn && state.role === 'host' && !aiStatus?.running) {
    aiBtn.disabled = submittedCount === 0;
  }

  if (statusRow && statusText) {
    if (aiStatus?.running) {
      statusText.textContent = aiStatus.message ?? 'AI is finding movies...';
      statusRow.style.display = 'flex';
      if (aiBtn) aiBtn.disabled = true;
    } else {
      statusRow.style.display = 'none';
    }
  }
}

function updateAiConnectionUi() {
  const mode = getAiConnectionMode();
  const bridgeBtn = document.getElementById('ai-mode-bridge-btn');
  const directBtn = document.getElementById('ai-mode-direct-btn');
  const bridgePanel = document.getElementById('bridge-config-panel');
  const directPanel = document.getElementById('direct-config-panel');
  const bridgeInput = document.getElementById('bridge-url-input');
  if (bridgeBtn) bridgeBtn.classList.toggle('active', mode === 'bridge');
  if (directBtn) directBtn.classList.toggle('active', mode === 'direct');
  if (bridgePanel) bridgePanel.style.display = mode === 'bridge' ? 'flex' : 'none';
  if (directPanel) directPanel.style.display = mode === 'direct' ? 'flex' : 'none';
  if (bridgeInput && !bridgeInput.value) bridgeInput.value = getBridgeUrl();
}

// ── Init ──────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  if (!initFirebase()) {
    showScreen('screen-setup-needed');
    return;
  }

  initYearRangeSelect();

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
      state.movies = normaliseMoviesFromFirebase(session.movies);
      if (session.status === 'lobby') {
        showLobby(savedCode, savedRole === 'host', session.aiMode ?? false);
        // showLobby already calls fbListen(onSessionUpdate)
        return;
      }
      if (session.status === 'swiping') {
        const myEntry = session.participants?.[state.userId];
        if (myEntry?.done) {
          showScreen('screen-waiting');
          updateWaitingProgress(session.participants);
        } else {
          // Restore swipe progress from sessionStorage if available — the user
          // refreshed mid-swipe and we want to pick up exactly where they left
          // off (same shuffle order, same currentIdx, same swipes recorded).
          const savedMovies = sessionStorage.getItem('pf_movies');
          const savedSwipes = sessionStorage.getItem('pf_swipes');
          const savedIdx    = sessionStorage.getItem('pf_idx');
          if (savedMovies && savedIdx) {
            try {
              state.movies     = JSON.parse(savedMovies);
              state.swipes     = savedSwipes ? JSON.parse(savedSwipes) : {};
              state.currentIdx = parseInt(savedIdx, 10) || 0;
              resumeSwiping();
            } catch {
              startSwiping();
            }
          } else {
            startSwiping();
          }
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
    // Reset the Connect-with-Plex button + status: the success path navigates
    // away without re-enabling it, so a returning host would otherwise see a
    // stuck disabled button.
    setBtn('btn-connect-plex', false,
      `<svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><path d="M11.09 2.16L4.5 7.43v9.14l6.59 5.27 6.59-5.27V7.43L11.09 2.16zm4.34 12.59l-4.34 3.47-4.34-3.47V9.25l4.34-3.47 4.34 3.47v5.5z"/></svg> Connect with Plex`);
    const statusEl = document.getElementById('auth-status');
    statusEl.style.display = 'none';
    statusEl.className = 'auth-status';
    showScreen('screen-auth');
    document.getElementById('host-name-input').focus();
  };

  document.getElementById('btn-join-session').onclick = () => {
    const code = document.getElementById('join-code-input').value.trim().toUpperCase();
    if (code.length !== 6) { toast('Enter a valid session code', 'error'); return; }
    state.sessionCode = code;
    state.role = 'guest';
    // Reset the Join button — success path navigates away and never re-enables.
    setBtn('btn-join-confirm', false, 'Join Session →');
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
      const session = await joinSession(state.sessionCode);
      sessionStorage.setItem('pf_session', state.sessionCode);
      sessionStorage.setItem('pf_role', 'guest');
      showLobby(state.sessionCode, false, session.aiMode ?? false);
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

      // Warn host once if TMDB isn't configured — guests will get unreliable
      // posters because the Plex relay throttles to 1 Mbps per user.
      if (!window.tmdbApiKey || window.tmdbApiKey === 'YOUR_TMDB_API_KEY') {
        toast('TMDB key missing — guest posters may be slow. See repo secrets.', 'error');
      }

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
  // Pick Another Set keeps the same session/code/participants/filters and
  // just refreshes the movie pool. Everyone gets transitioned back to swiping.
  document.getElementById('btn-play-again').onclick      = startNewRound;
  document.getElementById('btn-winner-play-again').onclick = startNewRound;
  document.getElementById('btn-leave-session').onclick     = clearSession;

  // Persistent leave button on every session screen (lobby/swipe/waiting/wheel).
  // Confirms first so people don't accidentally tap out mid-game.
  document.querySelectorAll('[data-quit]').forEach(btn => {
    btn.onclick = () => { if (confirm('Leave this session?')) clearSession(); };
  });

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
      pendingSpin: { eliminateId, targetAngle: finalAngle, startedAt: Date.now() },
    });
  };

  // btn-winner-play-again is wired to startNewRound above (results section);
  // the winner overlay shares the same handler.
  document.getElementById('btn-winner-leave').onclick = clearSession;

  // ── AI Mode ──
  // AI toggle (library screen)
  document.getElementById('ai-toggle-row').onclick = () => {
    state.aiMode = !state.aiMode;
    const row   = document.getElementById('ai-toggle-row');
    const track = document.getElementById('ai-toggle-track');
    const sec   = document.getElementById('ai-config-section');
    row.setAttribute('aria-pressed', String(state.aiMode));
    track.classList.toggle('on', state.aiMode);
    sec.style.display = state.aiMode ? 'flex' : 'none';
    if (state.aiMode) {
      sec.style.flexDirection = 'column';
      updateAiConnectionUi();
      document.getElementById('bridge-url-input').value = getBridgeUrl();
      const savedLm     = getLmEndpoint();
      const savedRadarr = getRadarrConfig();
      if (savedLm)           document.getElementById('lm-endpoint-input').value  = savedLm;
      if (savedRadarr.url)   document.getElementById('radarr-url-input').value   = savedRadarr.url;
      if (savedRadarr.key)   document.getElementById('radarr-key-input').value   = savedRadarr.key;
    }
  };

  document.getElementById('ai-mode-bridge-btn').onclick = () => {
    setAiConnectionMode('bridge');
    updateAiConnectionUi();
  };
  document.getElementById('ai-mode-direct-btn').onclick = () => {
    setAiConnectionMode('direct');
    updateAiConnectionUi();
  };

  document.getElementById('btn-test-bridge').onclick = async () => {
    const url = document.getElementById('bridge-url-input').value.trim();
    if (!url) { toast('Enter your PickFlick Bridge URL first', 'error'); return; }
    const result = document.getElementById('bridge-test-result');
    result.style.display = 'block';
    result.className = '';
    result.textContent = 'Testing...';
    try {
      const health = await testBridgeConnection(url);
      const lm = health.config?.lmStudio ?? {};
      const radarr = health.config?.radarr ?? {};
      if (lm.modelId) setLmModelId(lm.modelId);
      result.className = lm.configured ? 'ok' : 'error';
      result.textContent = lm.configured
        ? `Bridge connected - LM model: ${lm.modelId}${radarr.configured ? ' - Radarr ready' : ' - Radarr not configured'}`
        : 'Bridge connected, but LM Studio is not configured. Open the bridge setup page and choose a model.';
    } catch (e) {
      result.className = 'error';
      result.textContent = e.message;
    }
  };

  // Test LM Studio connection
  document.getElementById('btn-test-lm').onclick = async () => {
    const url = document.getElementById('lm-endpoint-input').value.trim();
    if (!url) { toast('Enter an LM Studio URL first', 'error'); return; }
    const endpoint = setLmEndpoint(url);
    const result = document.getElementById('lm-test-result');
    result.style.display = 'block';
    result.className     = '';
    result.textContent   = '🔌 Testing…';
    try {
      const { models } = await testLmConnection(endpoint);
      const modelId = models[0]?.id ?? '';
      if (modelId) setLmModelId(modelId);
      else setLmModelId('');
      result.className = modelId ? 'ok' : 'error';
      result.textContent = modelId
        ? `Connected - ${modelId}`
        : 'Connected, but no model is loaded';
    } catch (e) {
      result.className   = 'error';
      result.textContent = `❌ ${e.message}`;
    }
  };

  // Test Radarr connection
  document.getElementById('btn-test-radarr').onclick = async () => {
    const url = document.getElementById('radarr-url-input').value.trim();
    const key = document.getElementById('radarr-key-input').value.trim();
    if (!url || !key) { toast('Enter Radarr URL and API key first', 'error'); return; }
    setRadarrConfig(normalizeEndpoint(url), key);
    const result = document.getElementById('radarr-test-result');
    result.style.display = 'block';
    result.className     = '';
    result.textContent   = '📡 Testing…';
    try {
      const { version } = await testRadarrConnection(normalizeEndpoint(url), key);
      result.className   = 'ok';
      result.textContent = `✅ Connected · Radarr v${version}`;
    } catch (e) {
      result.className   = 'error';
      result.textContent = `❌ ${e.message}`;
    }
  };

  // Submit AI description (participants in lobby)
  document.getElementById('btn-submit-ai-desc').onclick = async () => {
    const text = document.getElementById('ai-desc-input').value.trim();
    if (!text) { toast('Describe what you want to watch first', 'error'); return; }
    const btn = document.getElementById('btn-submit-ai-desc');
    btn.disabled = true;
    try {
      await fbSet(
        `sessions/${state.sessionCode}/aiDescriptions/${state.userId}`,
        { name: state.userName, text }
      );
      document.getElementById('ai-desc-submitted-notice').style.display = 'flex';
    } catch (e) {
      toast('Failed to save preferences — check your connection.', 'error');
      btn.disabled = false;
    }
  };

  // Host "Find Movies with AI" button
  document.getElementById('btn-ai-find-movies').onclick = runAiPick;
}

function wireLibraryForm(servers, initialLibs) {
  const serverSel   = document.getElementById('select-server');
  const librarySel  = document.getElementById('select-library');
  const genreSel    = document.getElementById('select-genre');
  const yearSel     = document.getElementById('select-year-range');
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

  yearSel.onchange = async () => {
    await refreshMovieCount(state.plexLibrary.key, genreSel.value);
  };

  durationSel.onchange = async () => {
    await refreshMovieCount(state.plexLibrary.key, genreSel.value);
  };

  // ── Create session ──
  document.getElementById('btn-create-session').onclick = async () => {
    const sectionKey   = document.getElementById('select-library').value;
    const genreFastKey = document.getElementById('select-genre').value || null;

    // Validate AI mode before locking down the UI
    if (state.aiMode) {
      if (isBridgeMode()) {
        const bridgeUrl = document.getElementById('bridge-url-input').value.trim();
        if (!bridgeUrl) { toast('Enter your PickFlick Bridge URL to use AI Mode', 'error'); return; }
        try {
          const health = await testBridgeConnection(bridgeUrl);
          const modelId = health.config?.lmStudio?.modelId ?? '';
          if (!modelId) {
            toast('Open PickFlick Bridge setup, test LM Studio, choose a model, and save it.', 'error');
            return;
          }
          setLmModelId(modelId);
        } catch (e) {
          toast(e.message, 'error');
          return;
        }
      } else {
        const lmUrl = document.getElementById('lm-endpoint-input').value.trim();
        if (!lmUrl) { toast('Enter your LM Studio URL to use AI Mode', 'error'); return; }
        setLmEndpoint(lmUrl);
        // Save Radarr config if provided (optional)
        const radarrUrl = document.getElementById('radarr-url-input').value.trim();
        const radarrKey = document.getElementById('radarr-key-input').value.trim();
        if (radarrUrl && radarrKey) setRadarrConfig(radarrUrl, radarrKey);
      }
    }

    setBtn('btn-create-session', true);
    try {
      const raw      = await plexGetMovies(state.plexServerUri, sectionKey, genreFastKey, state.plexToken);
      const byYear   = applyYearFilter(raw);
      const byDur    = applyDurationFilter(byYear, getMaxDurationMs());
      const filtered = applyExcludeGenreFilter(byDur);
      if (!filtered.length) throw new Error('No movies found for that selection. Try adjusting the filters.');

      // In AI mode we create the session with a placeholder pool (the AI will
      // replace it when the host clicks "Find Movies with AI"). We still need
      // some movies in Firebase so guests can join — use a random sample.
      const picked      = pickMovies(filtered, MOVIES_COUNT);
      const tmdbPosters = await fetchTmdbPosters(picked);
      state.movies = picked.map(m => formatMovie(
        m, state.plexImageUri, state.plexToken, tmdbPosters[String(m.ratingKey)] ?? null
      ));

      const code = await createSession(state.movies, state.aiMode);
      state.sessionCode = code;

      showLobby(code, true, state.aiMode);
      const modeLabel = state.aiMode ? 'AI Mode · ' : '';
      document.getElementById('lobby-movie-info').textContent =
        `${modeLabel}${state.movies.length} movies · ${state.plexLibrary?.title ?? 'your library'}`;
    } catch (e) {
      if (e.message === 'PLEX_AUTH_EXPIRED') {
        toast('Plex sign-in expired — please reconnect.', 'error');
        clearSession();
      } else {
        toast(e.message, 'error');
      }
    } finally {
      setBtn('btn-create-session', false, '🚀 Create Session');
    }
  };
}

// Host kicks off another round in the SAME session — same code, same
// participants, same filters — but a fresh pool of movies. Everyone (host +
// guests) is transitioned back to swiping via onSessionUpdate when status
// flips back to 'swiping'.
async function startNewRound() {
  if (state.role !== 'host') {
    toast('Ask the host to start a new set.', 'info');
    return;
  }
  if (state.aiMode) {
    await fbUpdate(`sessions/${state.sessionCode}`, {
      status: 'lobby',
      swipes: null,
      wheel: null,
      aiStatus: null,
    });

    const overlay = document.getElementById('winner-overlay');
    if (overlay) overlay.style.display = 'none';
    wheelMovies = []; wheelRotation = 0; wheelAnimating = false;
    _latestWheelData = null; _lastAnimatedSpinId = null;
    if (wheelUnsubscribe) { wheelUnsubscribe(); wheelUnsubscribe = null; }
    if (sessionUnsubscribe) { sessionUnsubscribe(); sessionUnsubscribe = null; }

    showLobby(state.sessionCode, state.role === 'host', true);
    toast('Back to AI lobby - update preferences or find movies again.', 'info');
    return;
  }
  if (!state.plexLibrary?.key || !state.plexServerUri || !state.plexToken) {
    toast('Plex connection lost — leaving session.', 'error');
    clearSession();
    return;
  }

  setBtn('btn-play-again',        true);
  setBtn('btn-winner-play-again', true);
  try {
    const sectionKey   = state.plexLibrary.key;
    const genreFastKey = document.getElementById('select-genre')?.value || null;
    const raw          = await plexGetMovies(state.plexServerUri, sectionKey, genreFastKey, state.plexToken);
    const byYear       = applyYearFilter(raw);
    const byDur        = applyDurationFilter(byYear, getMaxDurationMs());
    const filtered     = applyExcludeGenreFilter(byDur);
    if (!filtered.length) throw new Error('No movies left to show — adjust filters and try again.');

    const picked      = pickMovies(filtered, MOVIES_COUNT);
    const tmdbPosters = await fetchTmdbPosters(picked);
    const newMovies   = picked.map(m => formatMovie(
      m, state.plexImageUri, state.plexToken, tmdbPosters[String(m.ratingKey)] ?? null
    ));

    // Atomic multi-path reset: new movie pool, wipe all swipes + wheel,
    // unset every participant's done flag, status back to 'swiping'.
    const session = await fbGet(`sessions/${state.sessionCode}`);
    const updates = {
      [`sessions/${state.sessionCode}/movies`]: newMovies,
      [`sessions/${state.sessionCode}/swipes`]: null,
      [`sessions/${state.sessionCode}/wheel`]:  null,
      [`sessions/${state.sessionCode}/status`]: 'swiping',
    };
    Object.keys(session?.participants ?? {}).forEach(uid => {
      updates[`sessions/${state.sessionCode}/participants/${uid}/done`] = false;
    });
    await db.ref('/').update(updates);

    // Host transitions locally — guests pick this up via the new
    // results/wheel → swiping transition in onSessionUpdate.
    const overlay = document.getElementById('winner-overlay');
    if (overlay) overlay.style.display = 'none';
    wheelMovies = []; wheelRotation = 0; wheelAnimating = false;
    _latestWheelData = null; _lastAnimatedSpinId = null;
    if (wheelUnsubscribe) { wheelUnsubscribe(); wheelUnsubscribe = null; }
    state.movies     = newMovies;
    state.swipes     = {};
    state.currentIdx = 0;
    clearSwipeProgress();
    startSwiping();
  } catch (e) {
    if (e.message === 'PLEX_AUTH_EXPIRED') {
      toast('Plex sign-in expired — please reconnect.', 'error');
      clearSession();
    } else {
      toast(e.message, 'error');
    }
  } finally {
    setBtn('btn-play-again',        false, '🔄 Pick Another Set');
    setBtn('btn-winner-play-again', false, '🔄 Play Again');
  }
}

function clearSession() {
  if (sessionUnsubscribe) { sessionUnsubscribe(); sessionUnsubscribe = null; }
  if (wheelUnsubscribe)   { wheelUnsubscribe();   wheelUnsubscribe   = null; }
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
  clearSwipeProgress();
  // Reset all session-scoped state including Plex auth — clearSession sends the
  // user back to landing, where they must re-authenticate to do anything.
  state.sessionCode    = null;
  state.movies         = [];
  state.swipes         = {};
  state.currentIdx     = 0;
  state.plexToken      = null;
  state.plexServers    = [];
  state.plexServerUri  = null;
  state.plexImageUri   = null;
  state.plexLibrary    = null;
  state.userName       = null;
  state.role           = null;
  state.aiMode         = false;
  state.excludedGenres.clear();
  document.querySelectorAll('#exclude-genre-chips .genre-chip.excluded')
    .forEach(chip => chip.classList.remove('excluded'));
  showScreen('screen-landing');
}
