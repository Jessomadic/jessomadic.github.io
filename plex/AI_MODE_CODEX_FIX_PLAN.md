# PickFlick AI Mode Codex Fix Plan

This document is a handoff for the desktop Codex pass on the PickFlick / Plex AI Mode feature.

## Current state

- Repo: `Jessomadic/jessomadic.github.io`
- Existing AI feature branch/PR from Claude: `claude/plex-movie-swipe-app-7HZHi` / PR #1
- ChatGPT follow-up PR #2 was closed and should not be used.
- The AI feature is mostly implemented in `plex/app.js` and `plex/index.html`, but it should not be merged as-is.

## Goal

Harden the AI Mode feature before merging it to `main`.

The desired final behavior:

1. Host enables AI Mode during library setup.
2. Participants join the lobby and submit movie-night preferences.
3. Host clicks **Find Movies with AI**.
4. If not everyone submitted preferences, show a confirmation before continuing.
5. AI processing status is synchronized through Firebase so every participant sees progress.
6. Large Plex libraries are chunked before being sent to LM Studio to avoid context overflow.
7. LM Studio uses the actual loaded model ID returned by `/v1/models`, not a hardcoded model name.
8. AI-selected Plex movies and optional TMDB/Radarr suggestions become the shared swipe deck.
9. Host and guests transition into swiping only through Firebase session state, not separate local transitions.
10. AI Mode replay returns to the AI lobby or reruns AI cleanly instead of falling back to the normal random picker.

---

## Files to edit

Primary files:

- `plex/app.js`
- `plex/index.html`

Optional cleanup:

- Update PR #1 title/body if using that PR.
- Delete/ignore branch `chatgpt/ai-mode-fixes` if no longer needed.

---

## Required fixes

### 1. Make `tmdbId` parsing Firebase-safe

Current code in `formatMovie()` uses `parseInt()` directly. If Plex has a malformed `tmdb://` GUID, this can produce `NaN`, and Firebase Realtime Database rejects invalid numeric values.

Replace unsafe parsing with:

```js
const tmdbGuid = (m.Guid ?? []).find(g => g.id?.startsWith('tmdb://'));
const parsedTmdbId = tmdbGuid ? Number.parseInt(tmdbGuid.id.slice('tmdb://'.length), 10) : null;
const tmdbId = Number.isFinite(parsedTmdbId) ? parsedTmdbId : null;
```

Also add a helper for deduping raw Plex movies by TMDB ID:

```js
function rawTmdbId(m) {
  const tmdbGuid = (m.Guid ?? []).find(g => g.id?.startsWith('tmdb://'));
  const parsed = tmdbGuid ? Number.parseInt(tmdbGuid.id.slice('tmdb://'.length), 10) : null;
  return Number.isFinite(parsed) ? parsed : null;
}
```

---

### 2. Store and use the actual LM Studio model ID

Current `callLmStudio()` hardcodes:

```js
model: 'local-model'
```

This is fragile. `testLmConnection()` already reads `/v1/models`. Store the first loaded model ID in `sessionStorage` and reuse it.

Add:

```js
function getLmModelId() {
  return sessionStorage.getItem('pf_lm_model_id') ?? '';
}

function setLmModelId(modelId) {
  if (modelId) sessionStorage.setItem('pf_lm_model_id', modelId);
  else sessionStorage.removeItem('pf_lm_model_id');
}
```

When testing LM Studio:

```js
const { models } = await testLmConnection(url);
const modelId = models[0]?.id ?? '';
if (modelId) setLmModelId(modelId);
result.className = modelId ? 'ok' : 'error';
result.textContent = modelId
  ? `✅ Connected · ${modelId}`
  : '❌ Connected, but no model is loaded';
```

Change `callLmStudio()` signature:

```js
async function callLmStudio(endpoint, modelId, systemPrompt, userPrompt) {
```

And payload:

```js
model: modelId,
```

In `runAiPick()`, before calling AI:

```js
let modelId = getLmModelId();
if (!modelId) {
  const { models } = await testLmConnection(endpoint);
  modelId = models[0]?.id ?? '';
  if (modelId) setLmModelId(modelId);
}
if (!modelId) {
  throw new Error('No LM Studio model is loaded. Load a model, test the connection, and try again.');
}
```

---

### 3. Synchronize AI processing status through Firebase

Current status messages are local to the host only. Guests can sit idle with no indication that AI is running.

Add helper:

```js
async function syncAiStatus(message, running = true) {
  if (!state.sessionCode) return;
  const payload = running
    ? { running: true, message, updatedAt: Date.now() }
    : null;

  await fbUpdate(`sessions/${state.sessionCode}`, { aiStatus: payload }).catch(() => {});
}
```

In `runAiPick()` replace local-only status setter:

```js
const setStatus = async msg => {
  if (statusEl) statusEl.textContent = msg;
  await syncAiStatus(msg, true);
};
```

Use `await setStatus(...)` for every AI step.

When AI succeeds and writes `status: 'swiping'`, also clear status:

```js
updates[`sessions/${state.sessionCode}/aiStatus`] = null;
```

When AI fails:

```js
await syncAiStatus(e.message, false);
```

Update lobby listener:

```js
if (session.aiMode) {
  updateAiDescriptionStatus(session.participants, session.aiDescriptions, session.aiStatus);
}
```

Update `updateAiDescriptionStatus()` to show `aiStatus.message` to everyone:

```js
function updateAiDescriptionStatus(participants, descriptions, aiStatus = null) {
  const statusList = document.getElementById('ai-desc-status-list');
  const statusDiv  = document.getElementById('ai-desc-status');
  const statusRow  = document.getElementById('ai-pick-status-row');
  const statusText = document.getElementById('ai-pick-status-text');
  const aiBtn      = document.getElementById('btn-ai-find-movies');

  if (!statusList || !statusDiv) return;

  const parts = Object.entries(participants ?? {}).filter(([, p]) => p);
  if (!parts.length) {
    statusDiv.style.display = 'none';
    return;
  }

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
      statusText.textContent = aiStatus.message ?? 'AI is finding movies…';
      statusRow.style.display = 'flex';
      if (aiBtn) aiBtn.disabled = true;
    } else if (state.role !== 'host') {
      statusRow.style.display = 'none';
    }
  }
}
```

---

### 4. Add confirmation before running AI when not everyone submitted preferences

In `runAiPick()`, after loading session/descriptions:

```js
const sessionBefore = await fbGet(`sessions/${state.sessionCode}`);
const participants = Object.values(sessionBefore?.participants ?? {}).filter(Boolean);
const descriptions = sessionBefore?.aiDescriptions ?? {};
const descCount = Object.values(descriptions).filter(d => d?.text?.trim()).length;

if (descCount === 0) {
  throw new Error('Nobody has submitted their preferences yet! Ask participants to describe what they want to watch.');
}

if (participants.length > descCount) {
  const ok = confirm(`Only ${descCount}/${participants.length} people submitted preferences. Run AI anyway?`);
  if (!ok) throw new Error('AI pick cancelled — waiting for more preferences.');
}
```

This satisfies the requested “Show confirmation” behavior.

---

### 5. Chunk the Plex catalog before sending to AI

Do not send the full Plex library as one giant JSON prompt. Use chunks, then optionally run a final narrowing pass.

Add helper:

```js
function chunkArray(arr, size) {
  const chunks = [];
  for (let i = 0; i < arr.length; i += size) chunks.push(arr.slice(i, i + size));
  return chunks;
}
```

Add chunked AI selector:

```js
async function runChunkedAiSelection(endpoint, modelId, pool, descriptions, setStatus) {
  const catalog = buildAiCatalog(pool);
  const chunks = chunkArray(catalog, 250);
  const selectedIds = new Set();
  const suggestions = [];
  const reasons = [];

  for (let i = 0; i < chunks.length; i++) {
    await setStatus(`🧠 Reading library chunk ${i + 1}/${chunks.length} (${chunks[i].length} movies)…`);

    const raw = await callLmStudio(
      endpoint,
      modelId,
      buildAiSystemPrompt(),
      buildAiUserPrompt(chunks[i], descriptions)
    );

    const parsed = parseLmResponse(raw);
    parsed.selected.slice(0, 14).forEach(id => selectedIds.add(String(id)));
    (parsed.suggestions ?? []).slice(0, 2).forEach(s => suggestions.push(s));
    if (parsed.reason) reasons.push(parsed.reason);
  }

  const candidates = catalog.filter(m => selectedIds.has(String(m.id)));

  if (chunks.length <= 1 || candidates.length <= MOVIES_COUNT) {
    return {
      selected: candidates.slice(0, MOVIES_COUNT).map(m => String(m.id)),
      suggestions: suggestions.slice(0, 8),
      reason: reasons[0] ?? 'AI matched the group preferences.'
    };
  }

  await setStatus(`🧠 Narrowing ${candidates.length} candidates into the final deck…`);

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
    reason: finalParsed.reason ?? reasons[0] ?? 'AI matched the group preferences.'
  };
}
```

In `runAiPick()` replace the single huge prompt call with:

```js
const parsed = await runChunkedAiSelection(endpoint, modelId, pool, descriptions, setStatus);
const selected = new Set(parsed.selected.map(String));
```

---

### 6. Remove the host double-transition into swiping

Current `runAiPick()` writes Firebase status to `swiping`, then immediately does:

```js
state.movies = newMovies;
startSwiping();
```

Remove those local transition lines. Let `onSessionUpdate()` transition host and guests together.

Use:

```js
await db.ref('/').update(updates);
// Let the Firebase session listener transition host and guests together.
```

This avoids double shuffle, double reset, and host-only race conditions.

---

### 7. Deduplicate suggestions by TMDB ID, not only title

Current code only compares lowercase titles. Add TMDB ID dedupe:

```js
const existingTitles = new Set(pool.map(m => (m.title ?? '').toLowerCase()));
const existingTmdbIds = new Set(pool.map(rawTmdbId).filter(id => id !== null));
const suggestionsRaw = (parsed.suggestions ?? []).slice(0, 8);

const suggestionsResolved = await Promise.allSettled(
  suggestionsRaw
    .filter(s => s?.title && !existingTitles.has((s.title ?? '').toLowerCase()))
    .map(s => tmdbSearchMovie(s.title, s.year))
);

const suggestedMovies = suggestionsResolved
  .filter(r => r.status === 'fulfilled' && r.value && !existingTmdbIds.has(r.value.tmdbId))
  .map(r => formatSuggestedMovie(r.value));
```

---

### 8. Fix AI Mode replay / Play Again behavior

The normal `startNewRound()` path should not randomly repick movies for an AI session.

At the top of `startNewRound()` add:

```js
if (state.aiMode) {
  await fbUpdate(`sessions/${state.sessionCode}`, {
    status: 'lobby',
    swipes: null,
    wheel: null,
    aiStatus: null,
  });

  const overlay = document.getElementById('winner-overlay');
  if (overlay) overlay.style.display = 'none';

  showLobby(state.sessionCode, state.role === 'host', true);
  toast('Back to AI lobby — update preferences or find movies again.', 'info');
  return;
}
```

Also verify `showLobby()` handles existing AI descriptions correctly after replay.

---

### 9. Improve AI toggle accessibility

The AI toggle is currently a clickable `div`. Change it to a button in `plex/index.html`:

```html
<button type="button" class="ai-toggle-row" id="ai-toggle-row" aria-pressed="false" style="width:100%;background:none;border:0;text-align:left">
```

Close it with `</button>` instead of `</div>`.

When toggled in JS:

```js
const row = document.getElementById('ai-toggle-row');
row.setAttribute('aria-pressed', String(state.aiMode));
```

---

### 10. Add browser networking warnings for LM Studio and Radarr

Because the site is hosted over HTTPS on GitHub Pages, local HTTP services can fail due to mixed-content rules, CORS, or private-network browser restrictions.

Add UI helper text under LM Studio:

```html
LM Studio must have <strong style="color:var(--subtle)">CORS enabled</strong> (Settings → Server) and a model loaded.
Because this page is served over HTTPS, local/private-network URLs may also need HTTPS or browser private-network access permissions. URL stays on this device — never shared.
```

Add UI helper text under Radarr:

```html
Radarr is optional. From GitHub Pages, local Radarr URLs may require HTTPS, CORS, or a local proxy to work in your browser.
```

---

## Recommended final validation

After making the changes:

1. Run JavaScript syntax check:

```bash
node --check plex/app.js
```

2. Test normal non-AI flow:

- Connect Plex
- Select library
- Create normal session
- Swipe
- Results / wheel still work
- Play Again still works

3. Test AI flow with one browser:

- Enable AI Mode
- Test LM Studio
- Create session
- Submit preference
- Find Movies with AI
- Confirm swipe deck appears

4. Test AI flow with two browsers/devices:

- Host and guest join same code
- Guest submits preferences
- Host sees submitted status
- Host starts AI
- Guest sees synced AI processing status
- Both transition to swiping from Firebase

5. Test partial submission confirmation:

- Host + guest in lobby
- Only host submits preference
- Host clicks AI button
- Browser confirmation appears
- Cancel keeps lobby intact
- Confirm runs AI

6. Test large library:

- Use a library with more than 250 movies
- Confirm statuses show chunk progress
- Confirm LM Studio does not receive one massive full-library prompt

7. Test non-library suggestion:

- Confirm `Not in library` chip appears
- Confirm TMDB poster/metadata resolves
- Confirm duplicate suggestions already in Plex are filtered by TMDB ID

8. Test Radarr optional behavior:

- No Radarr config: app still works; no Radarr buttons shown
- Valid Radarr config: Add button appears for non-library winner
- Bad Radarr config: clear error toast, no app crash

---

## Merge guidance

Do not merge PR #1 until the above fixes are applied and validated.

Preferred path:

1. Use Codex desktop to apply the changes directly to a clean branch from `claude/plex-movie-swipe-app-7HZHi` or from `main` plus the AI feature commits.
2. Run `node --check plex/app.js`.
3. Open or update a PR with a title like:

```text
Add AI Mode movie picker with synchronized LM Studio flow
```

4. Merge to `main` after testing.
