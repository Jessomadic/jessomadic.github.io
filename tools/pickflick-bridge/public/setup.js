'use strict';

const $ = id => document.getElementById(id);

const savedSelections = {
  lmModelId: '',
  radarrRootFolderPath: '',
  radarrQualityProfileId: '',
};

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
  const rawHost = $(hostId).value.trim() || '127.0.0.1';
  const port = $(portId).value.trim() || String(fallbackPort);
  if (/^https?:\/\//i.test(rawHost)) {
    const url = new URL(rawHost);
    url.port = port;
    return url.toString().replace(/\/+$/, '');
  }
  return `http://${rawHost.replace(/\/+$/, '')}:${port}`;
}

function buildBridgeUrl(host, port) {
  let cleanHost = String(host || '127.0.0.1').trim();
  try {
    const parsed = new URL(/^https?:\/\//i.test(cleanHost) ? cleanHost : `http://${cleanHost}`);
    cleanHost = parsed.hostname;
  } catch {
    cleanHost = cleanHost.replace(/^https?:\/\//i, '').replace(/\/.*$/, '').replace(/:\d+$/, '');
  }
  const cleanPort = String(port || '8765').trim() || '8765';
  return `http://${cleanHost}:${cleanPort}`;
}

function setBridgeUrlText(url) {
  $('bridge-url').textContent = url;
  $('bridge-url-copy').textContent = url;
  const phoneUrl = `${String(url || '').replace(/\/+$/, '')}/pickflick/`;
  $('phone-app-url').textContent = phoneUrl;
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

function selectValueIfAvailable(select, value) {
  const target = String(value || '');
  if (!target) return false;
  const option = Array.from(select.options).find(item => item.value === target);
  if (!option) return false;
  select.value = target;
  return true;
}

function renderBridgeStatus(health) {
  const version = health.version ? `v${health.version}` : 'unknown version';
  const hasLmAuthSupport = !!health.features?.lmStudioApiKey;
  const hasBridgeHostConfig = !!health.features?.bridgeHostConfig;
  const current = hasLmAuthSupport && hasBridgeHostConfig;
  $('bridge-status').textContent = current ? `Running ${version}` : `Restart needed (${version})`;
  $('bridge-status').className = current ? 'status ok' : 'status error';
  if (!current) {
    setResult(
      'bridge-result',
      false,
      'The setup page is newer than the running bridge process. Restart or reinstall PickFlick Bridge, then refresh this page.'
    );
  }
}

async function loadConfig() {
  const health = await api('/health');
  renderBridgeStatus(health);

  const bridge = health.config.bridge;
  $('bridge-host').value = bridge.host || location.hostname || '127.0.0.1';
  $('bridge-port').value = bridge.port || location.port || '8765';
  $('bridge-listen-host').value = bridge.listenHost || '0.0.0.0';
  setBridgeUrlText(bridge.bridgeUrl || `http://${location.host}`);
  const datalist = $('bridge-host-suggestions');
  datalist.innerHTML = '';
  [...new Set([bridge.host, '127.0.0.1', ...(bridge.networkHosts || [])].filter(Boolean))].forEach(host => {
    const option = document.createElement('option');
    option.value = host;
    datalist.appendChild(option);
  });

  const lm = health.config.lmStudio;
  const lmParts = splitBaseUrl(lm.baseUrl, 1234);
  $('lm-host').value = lmParts.host;
  $('lm-port').value = lmParts.port;
  savedSelections.lmModelId = lm.modelId || '';
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
  savedSelections.radarrRootFolderPath = radarr.rootFolderPath || '';
  savedSelections.radarrQualityProfileId = radarr.qualityProfileId == null ? '' : String(radarr.qualityProfileId);
  if (savedSelections.radarrRootFolderPath) {
    fillSelect(
      $('radarr-root-select'),
      [{ path: savedSelections.radarrRootFolderPath }],
      folder => folder.path,
      folder => folder.path,
      'Choose root folder'
    );
    $('radarr-root-select').value = savedSelections.radarrRootFolderPath;
  }
  if (savedSelections.radarrQualityProfileId) {
    fillSelect(
      $('radarr-quality-select'),
      [{ id: savedSelections.radarrQualityProfileId, name: `Saved profile ID ${savedSelections.radarrQualityProfileId}` }],
      profile => profile.id,
      profile => profile.name,
      'Choose quality profile'
    );
    $('radarr-quality-select').value = savedSelections.radarrQualityProfileId;
  }
  $('btn-save-radarr').disabled = !(
    radarr.configured &&
    savedSelections.radarrRootFolderPath &&
    savedSelections.radarrQualityProfileId
  );
  if (radarr.hasApiKey) $('radarr-key').placeholder = 'Saved API key (enter a new key to change)';
  $('btn-verify-radarr').disabled = !radarr.configured;
}

async function saveBridge() {
  $('btn-save-bridge').disabled = true;
  setResult('bridge-result', true, 'Saving bridge address...');
  try {
    const host = $('bridge-host').value.trim();
    const port = $('bridge-port').value.trim() || '8765';
    const listenHost = $('bridge-listen-host').value.trim() || '0.0.0.0';
    const data = await api('/api/bridge/save', {
      method: 'POST',
      body: JSON.stringify({ host, port, listenHost }),
    });
    const url = data.config?.bridge?.bridgeUrl || buildBridgeUrl(host, port);
    setBridgeUrlText(url);
    setResult(
      'bridge-result',
      true,
      data.restartRequired
        ? `Saved ${url}. Restart PickFlick Bridge for listen address or port changes to take effect.`
        : `Saved ${url}. Use this URL in PickFlick AI Mode.`
    );
  } catch (e) {
    setResult('bridge-result', false, e.message);
  } finally {
    $('btn-save-bridge').disabled = false;
  }
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
    selectValueIfAvailable($('lm-model-select'), savedSelections.lmModelId);
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
    savedSelections.lmModelId = modelId;
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
    selectValueIfAvailable($('radarr-root-select'), savedSelections.radarrRootFolderPath);
    selectValueIfAvailable($('radarr-quality-select'), savedSelections.radarrQualityProfileId);
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
    savedSelections.radarrRootFolderPath = rootFolderPath;
    savedSelections.radarrQualityProfileId = String(qualityProfileId);
    setResult('radarr-result', true, 'Saved Radarr settings.');
    $('btn-verify-radarr').disabled = false;
    $('radarr-key').value = '';
    $('radarr-key').placeholder = 'Saved API key (enter a new key to change)';
  } catch (e) {
    setResult('radarr-result', false, e.message);
  }
}

async function verifyRadarr() {
  $('btn-verify-radarr').disabled = true;
  setResult('radarr-result', true, 'Verifying saved Radarr settings...');
  try {
    const data = await api('/radarr/validate', {
      method: 'POST',
      body: JSON.stringify({}),
    });
    setResult(
      'radarr-result',
      true,
      `Radarr ready${data.version ? ` v${data.version}` : ''}. Root: ${data.rootFolderPath}. Quality profile ID: ${data.qualityProfileId}.`
    );
  } catch (e) {
    setResult('radarr-result', false, e.message);
  } finally {
    $('btn-verify-radarr').disabled = false;
  }
}

document.addEventListener('DOMContentLoaded', async () => {
  $('btn-save-bridge').onclick = saveBridge;
  $('btn-test-lm').onclick = testLm;
  $('btn-save-lm').onclick = saveLm;
  $('btn-test-radarr').onclick = testRadarr;
  $('btn-save-radarr').onclick = saveRadarr;
  $('btn-verify-radarr').onclick = verifyRadarr;
  try {
    await loadConfig();
  } catch (e) {
    $('bridge-status').textContent = e.message;
    $('bridge-status').className = 'status error';
  }
});
