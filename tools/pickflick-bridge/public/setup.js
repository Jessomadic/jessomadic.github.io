'use strict';

const $ = id => document.getElementById(id);

function setResult(id, ok, message) {
  const el = $(id);
  el.hidden = false;
  el.className = `result ${ok ? 'ok' : 'error'}`;
  el.textContent = message;
}

function splitBaseUrl(baseUrl, fallbackPort) {
  try {
    const url = new URL(baseUrl || `http://127.0.0.1:${fallbackPort}`);
    return {
      host: url.hostname || '127.0.0.1',
      port: url.port || String(fallbackPort),
    };
  } catch {
    return { host: '127.0.0.1', port: String(fallbackPort) };
  }
}

function buildUrl(hostId, portId, fallbackPort) {
  const host = $(hostId).value.trim() || '127.0.0.1';
  const port = $(portId).value.trim() || String(fallbackPort);
  return `http://${host}:${port}`;
}

async function api(path, options = {}) {
  const res = await fetch(path, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.ok === false) {
    throw new Error(data.error || `HTTP ${res.status}`);
  }
  return data;
}

function fillSelect(select, items, getValue, getLabel, placeholder) {
  select.innerHTML = '';
  const first = document.createElement('option');
  first.value = '';
  first.textContent = placeholder;
  select.appendChild(first);
  items.forEach(item => {
    const option = document.createElement('option');
    option.value = getValue(item);
    option.textContent = getLabel(item);
    select.appendChild(option);
  });
  select.disabled = items.length === 0;
}

function renderBridgeStatus(health) {
  const version = health.version ? `v${health.version}` : 'unknown version';
  const hasLmAuthSupport = !!health.features?.lmStudioApiKey;
  $('bridge-status').textContent = hasLmAuthSupport ? `Running ${version}` : `Restart needed (${version})`;
  $('bridge-status').className = hasLmAuthSupport ? 'status ok' : 'status error';
  if (!hasLmAuthSupport) {
    setResult(
      'lm-result',
      false,
      'The setup page is updated, but the running bridge process is older and cannot forward the LM Studio API token yet. Restart or reinstall PickFlick Bridge, then refresh this page.'
    );
  }
}

async function loadConfig() {
  const health = await api('/health');
  renderBridgeStatus(health);
  $('bridge-url').textContent = `http://${location.host}`;

  const lm = health.config.lmStudio;
  const lmParts = splitBaseUrl(lm.baseUrl, 1234);
  $('lm-host').value = lmParts.host;
  $('lm-port').value = lmParts.port;
  if (lm.modelId) {
    fillSelect($('lm-model-select'), [{ id: lm.modelId }], m => m.id, m => m.id, 'Choose model');
    $('lm-model-select').value = lm.modelId;
    $('btn-save-lm').disabled = false;
  }
  if (lm.hasApiKey) $('lm-key').placeholder = 'Saved API token (enter a new token to change)';

  const radarr = health.config.radarr;
  const radarrParts = splitBaseUrl(radarr.baseUrl, 7878);
  $('radarr-host').value = radarrParts.host;
  $('radarr-port').value = radarrParts.port;
  if (radarr.hasApiKey) $('radarr-key').placeholder = 'Saved API key (enter a new key to change)';
}

async function testLm() {
  $('btn-test-lm').disabled = true;
  setResult('lm-result', true, 'Testing LM Studio...');
  try {
    const baseUrl = buildUrl('lm-host', 'lm-port', 1234);
    const data = await api('/api/lm/test', {
      method: 'POST',
      body: JSON.stringify({ baseUrl, apiKey: $('lm-key').value.trim() }),
    });
    fillSelect(
      $('lm-model-select'),
      data.models,
      model => model.id,
      model => model.id,
      data.models.length ? 'Choose model' : 'No loaded models found'
    );
    $('btn-save-lm').disabled = data.models.length === 0;
    setResult('lm-result', data.models.length > 0,
      data.models.length
        ? `Connected to LM Studio through ${data.endpoint}. Found ${data.models.length} model(s).`
        : 'Connected to LM Studio, but no model is loaded.');
  } catch (e) {
    $('lm-model-select').disabled = true;
    $('btn-save-lm').disabled = true;
    setResult('lm-result', false, e.message);
  } finally {
    $('btn-test-lm').disabled = false;
  }
}

async function saveLm() {
  const modelId = $('lm-model-select').value;
  if (!modelId) {
    setResult('lm-result', false, 'Choose a model first.');
    return;
  }
  try {
    await api('/api/lm/save', {
      method: 'POST',
      body: JSON.stringify({
        baseUrl: buildUrl('lm-host', 'lm-port', 1234),
        modelId,
        apiKey: $('lm-key').value.trim(),
      }),
    });
    setResult('lm-result', true, `Saved LM Studio model: ${modelId}`);
    $('lm-key').value = '';
    $('lm-key').placeholder = 'Saved API token (enter a new token to change)';
  } catch (e) {
    setResult('lm-result', false, e.message);
  }
}

async function testRadarr() {
  $('btn-test-radarr').disabled = true;
  setResult('radarr-result', true, 'Testing Radarr...');
  try {
    const baseUrl = buildUrl('radarr-host', 'radarr-port', 7878);
    const apiKey = $('radarr-key').value.trim();
    const data = await api('/api/radarr/test', {
      method: 'POST',
      body: JSON.stringify({ baseUrl, apiKey }),
    });
    fillSelect(
      $('radarr-root-select'),
      data.rootFolders,
      folder => folder.path,
      folder => folder.path,
      data.rootFolders.length ? 'Choose root folder' : 'No root folders found'
    );
    fillSelect(
      $('radarr-quality-select'),
      data.qualityProfiles,
      profile => profile.id,
      profile => profile.name,
      data.qualityProfiles.length ? 'Choose quality profile' : 'No quality profiles found'
    );
    $('btn-save-radarr').disabled = !(data.rootFolders.length && data.qualityProfiles.length);
    setResult('radarr-result', true, `Connected to Radarr ${data.version || ''}.`);
  } catch (e) {
    $('radarr-root-select').disabled = true;
    $('radarr-quality-select').disabled = true;
    $('btn-save-radarr').disabled = true;
    setResult('radarr-result', false, e.message);
  } finally {
    $('btn-test-radarr').disabled = false;
  }
}

async function saveRadarr() {
  const rootFolderPath = $('radarr-root-select').value;
  const qualityProfileId = $('radarr-quality-select').value;
  if (!rootFolderPath || !qualityProfileId) {
    setResult('radarr-result', false, 'Choose a root folder and quality profile first.');
    return;
  }
  try {
    await api('/api/radarr/save', {
      method: 'POST',
      body: JSON.stringify({
        baseUrl: buildUrl('radarr-host', 'radarr-port', 7878),
        apiKey: $('radarr-key').value.trim(),
        rootFolderPath,
        qualityProfileId,
      }),
    });
    setResult('radarr-result', true, 'Saved Radarr settings.');
    $('radarr-key').value = '';
    $('radarr-key').placeholder = 'Saved API key (enter a new key to change)';
  } catch (e) {
    setResult('radarr-result', false, e.message);
  }
}

document.addEventListener('DOMContentLoaded', async () => {
  $('btn-test-lm').onclick = testLm;
  $('btn-save-lm').onclick = saveLm;
  $('btn-test-radarr').onclick = testRadarr;
  $('btn-save-radarr').onclick = saveRadarr;
  try {
    await loadConfig();
  } catch (e) {
    $('bridge-status').textContent = e.message;
    $('bridge-status').className = 'status error';
  }
});
