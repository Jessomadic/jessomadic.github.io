// PickFlick Bridge
// Local-only bridge for GitHub Pages -> LM Studio / Radarr.
// No external npm dependencies.

'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');

const VERSION = '0.1.0';
const DEFAULT_PORT = 8765;
const DEFAULT_HOST = '127.0.0.1';
const PUBLIC_DIR = path.join(__dirname, 'public');
const DATA_DIR = process.env.PICKFLICK_BRIDGE_DATA
  || path.join(process.env.LOCALAPPDATA || os.homedir(), 'PickFlickBridge');
const CONFIG_PATH = process.env.PICKFLICK_BRIDGE_CONFIG
  || path.join(DATA_DIR, 'config.json');

const ALLOWED_ORIGINS = new Set([
  'https://jessomadic.github.io',
  'https://jessecopas.com',
  'https://www.jessecopas.com',
  'http://127.0.0.1',
  'http://localhost',
]);

function ensureDataDir() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

function defaultConfig() {
  return {
    bridge: {
      host: DEFAULT_HOST,
      port: DEFAULT_PORT,
    },
    lmStudio: {
      baseUrl: '',
      modelId: '',
      apiKey: '',
    },
    radarr: {
      baseUrl: '',
      apiKey: '',
      rootFolderPath: '',
      qualityProfileId: null,
    },
  };
}

function loadConfig() {
  ensureDataDir();
  try {
    const loaded = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    return mergeConfig(defaultConfig(), loaded);
  } catch {
    const config = defaultConfig();
    saveConfig(config);
    return config;
  }
}

function mergeConfig(base, loaded) {
  return {
    ...base,
    ...loaded,
    bridge: { ...base.bridge, ...(loaded.bridge || {}) },
    lmStudio: { ...base.lmStudio, ...(loaded.lmStudio || {}) },
    radarr: { ...base.radarr, ...(loaded.radarr || {}) },
  };
}

function saveConfig(config) {
  ensureDataDir();
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
}

let config = loadConfig();

function sanitizedConfig() {
  return {
    bridge: {
      host: config.bridge.host,
      port: Number(config.bridge.port) || DEFAULT_PORT,
      setupUrl: `http://${config.bridge.host || DEFAULT_HOST}:${Number(config.bridge.port) || DEFAULT_PORT}/setup`,
    },
    lmStudio: {
      baseUrl: config.lmStudio.baseUrl,
      modelId: config.lmStudio.modelId,
      hasApiKey: !!config.lmStudio.apiKey,
      configured: !!(config.lmStudio.baseUrl && config.lmStudio.modelId),
    },
    radarr: {
      baseUrl: config.radarr.baseUrl,
      configured: !!(config.radarr.baseUrl && config.radarr.apiKey),
      hasApiKey: !!config.radarr.apiKey,
      rootFolderPath: config.radarr.rootFolderPath,
      qualityProfileId: config.radarr.qualityProfileId,
    },
  };
}

function normalizeBaseUrl(input, defaultPort) {
  const raw = String(input || '').trim().replace(/\/+$/, '');
  if (!raw) return '';
  const withScheme = /^https?:\/\//i.test(raw) ? raw : `http://${raw}`;
  const url = new URL(withScheme);
  if (!url.port && defaultPort) url.port = String(defaultPort);
  return url.toString().replace(/\/+$/, '');
}

function applyCors(req, res) {
  const origin = req.headers.origin;
  if (!origin) return;
  let allowed = ALLOWED_ORIGINS.has(origin);
  if (!allowed) {
    allowed = /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/i.test(origin);
  }
  if (allowed) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  }
}

function sendJson(req, res, status, data) {
  applyCors(req, res);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(JSON.stringify(data));
}

function sendError(req, res, status, error) {
  sendJson(req, res, status, { ok: false, error: error.message || String(error) });
}

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const text = Buffer.concat(chunks).toString('utf8').trim();
  return text ? JSON.parse(text) : {};
}

async function fetchJson(url, options = {}, timeoutMs = 10000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...options, signal: ctrl.signal });
    const text = await res.text();
    let body = null;
    if (text) {
      try { body = JSON.parse(text); }
      catch { body = text; }
    }
    if (!res.ok) {
      const suffix = typeof body === 'string' ? `: ${body.slice(0, 240)}` : '';
      const err = new Error(`HTTP ${res.status}${suffix}`);
      err.status = res.status;
      err.body = body;
      throw err;
    }
    return body;
  } catch (e) {
    if (e.name === 'AbortError') throw new Error(`Timed out calling ${url}`);
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

function lmHeaders(apiKey, json = false) {
  const headers = {};
  const key = String(apiKey || '').trim();
  if (key) headers.Authorization = `Bearer ${key}`;
  if (json) headers['Content-Type'] = 'application/json';
  return headers;
}

function normalizeLmModels(data) {
  const list = Array.isArray(data)
    ? data
    : Array.isArray(data?.data)
      ? data.data
      : Array.isArray(data?.models)
        ? data.models
        : [];

  return list
    .map(model => {
      if (typeof model === 'string') return { id: model };
      const id = model?.id || model?.modelKey || model?.path || model?.name;
      return id ? { ...model, id: String(id) } : null;
    })
    .filter(Boolean);
}

async function testLm(baseUrl, apiKey = config.lmStudio.apiKey) {
  const normalized = normalizeBaseUrl(baseUrl, 1234);
  if (!normalized) throw new Error('LM Studio URL is required');
  const endpoints = ['/v1/models', '/api/v1/models', '/api/v0/models'];
  const errors = [];
  for (const endpoint of endpoints) {
    try {
      const data = await fetchJson(`${normalized}${endpoint}`, {
        headers: lmHeaders(apiKey),
      }, 10000);
      const models = normalizeLmModels(data);
      if (models.length) return { baseUrl: normalized, endpoint, models };
      errors.push(`${endpoint}: no models in response`);
    } catch (e) {
      if (e.status === 401) {
        throw new Error('LM Studio returned HTTP 401. If authentication is enabled in LM Studio Server Settings, paste an LM Studio API token here and test again.');
      }
      errors.push(`${endpoint}: ${e.message}`);
    }
  }
  throw new Error(`Could not list LM Studio models. Tried ${endpoints.join(', ')}. ${errors[errors.length - 1] || ''}`);
}

async function testRadarr(baseUrl, apiKey) {
  const normalized = normalizeBaseUrl(baseUrl, 7878);
  const key = String(apiKey || '').trim();
  if (!normalized) throw new Error('Radarr URL is required');
  if (!key) throw new Error('Radarr API key is required');
  const headers = { 'X-Api-Key': key };
  const [status, rootFolders, qualityProfiles] = await Promise.all([
    fetchJson(`${normalized}/api/v3/system/status`, { headers }, 10000),
    fetchJson(`${normalized}/api/v3/rootfolder`, { headers }, 10000),
    fetchJson(`${normalized}/api/v3/qualityprofile`, { headers }, 10000),
  ]);
  return {
    baseUrl: normalized,
    version: status?.version || '',
    rootFolders: Array.isArray(rootFolders) ? rootFolders : [],
    qualityProfiles: Array.isArray(qualityProfiles) ? qualityProfiles : [],
  };
}

function staticFile(filePath, contentType, res) {
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not found');
      return;
    }
    res.writeHead(200, {
      'Content-Type': contentType,
      'Cache-Control': 'no-store',
    });
    res.end(data);
  });
}

function mimeFor(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.html') return 'text/html; charset=utf-8';
  if (ext === '.js') return 'text/javascript; charset=utf-8';
  if (ext === '.css') return 'text/css; charset=utf-8';
  if (ext === '.svg') return 'image/svg+xml';
  return 'application/octet-stream';
}

async function route(req, res) {
  applyCors(req, res);
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const url = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`);
  const pathname = url.pathname;

  try {
    if (req.method === 'GET' && pathname === '/favicon.ico') {
      res.writeHead(204);
      res.end();
      return;
    }
    if (req.method === 'GET' && (pathname === '/' || pathname === '/setup')) {
      staticFile(path.join(PUBLIC_DIR, 'setup.html'), 'text/html; charset=utf-8', res);
      return;
    }
    if (req.method === 'GET' && pathname.startsWith('/setup.')) {
      const target = path.resolve(PUBLIC_DIR, pathname.slice(1));
      if (!target.startsWith(PUBLIC_DIR)) throw new Error('Invalid static path');
      staticFile(target, mimeFor(target), res);
      return;
    }
    if (req.method === 'GET' && pathname === '/health') {
      sendJson(req, res, 200, {
        ok: true,
        name: 'PickFlick Bridge',
        version: VERSION,
        config: sanitizedConfig(),
      });
      return;
    }
    if (req.method === 'GET' && pathname === '/api/config') {
      sendJson(req, res, 200, { ok: true, config: sanitizedConfig() });
      return;
    }
    if (req.method === 'POST' && pathname === '/api/lm/test') {
      const body = await readJson(req);
      const apiKey = body.apiKey ? String(body.apiKey).trim() : config.lmStudio.apiKey;
      const result = await testLm(body.baseUrl, apiKey);
      sendJson(req, res, 200, { ok: true, ...result });
      return;
    }
    if (req.method === 'POST' && pathname === '/api/lm/save') {
      const body = await readJson(req);
      const baseUrl = normalizeBaseUrl(body.baseUrl, 1234);
      const modelId = String(body.modelId || '').trim();
      const apiKey = body.apiKey ? String(body.apiKey).trim() : config.lmStudio.apiKey;
      if (!baseUrl) throw new Error('LM Studio URL is required');
      if (!modelId) throw new Error('Choose an LM Studio model');
      config.lmStudio.baseUrl = baseUrl;
      config.lmStudio.modelId = modelId;
      config.lmStudio.apiKey = apiKey;
      saveConfig(config);
      sendJson(req, res, 200, { ok: true, config: sanitizedConfig() });
      return;
    }
    if (req.method === 'GET' && pathname === '/lm/models') {
      const result = await testLm(config.lmStudio.baseUrl, config.lmStudio.apiKey);
      sendJson(req, res, 200, { ok: true, modelId: config.lmStudio.modelId, models: result.models });
      return;
    }
    if (req.method === 'POST' && pathname === '/lm/chat') {
      const body = await readJson(req);
      const baseUrl = normalizeBaseUrl(config.lmStudio.baseUrl, 1234);
      const model = String(body.modelId || body.model || config.lmStudio.modelId || '').trim();
      if (!baseUrl) throw new Error('LM Studio is not configured in PickFlick Bridge setup');
      if (!model) throw new Error('No LM Studio model is selected in PickFlick Bridge setup');
      const payload = {
        model,
        messages: [
          { role: 'system', content: String(body.systemPrompt || '') },
          { role: 'user', content: String(body.userPrompt || '') },
        ],
        temperature: Number.isFinite(body.temperature) ? body.temperature : 0.25,
        max_tokens: Number.isFinite(body.maxTokens) ? body.maxTokens : 1000,
        stream: false,
      };
      const data = await fetchJson(`${baseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: lmHeaders(config.lmStudio.apiKey, true),
        body: JSON.stringify(payload),
      }, 120000);
      sendJson(req, res, 200, {
        ok: true,
        content: data?.choices?.[0]?.message?.content || '',
        raw: data,
      });
      return;
    }
    if (req.method === 'POST' && pathname === '/api/radarr/test') {
      const body = await readJson(req);
      const result = await testRadarr(body.baseUrl, body.apiKey);
      sendJson(req, res, 200, { ok: true, ...result });
      return;
    }
    if (req.method === 'POST' && pathname === '/api/radarr/save') {
      const body = await readJson(req);
      const baseUrl = normalizeBaseUrl(body.baseUrl, 7878);
      const apiKey = String(body.apiKey || '').trim();
      if (!baseUrl) throw new Error('Radarr URL is required');
      if (!apiKey) throw new Error('Radarr API key is required');
      config.radarr.baseUrl = baseUrl;
      config.radarr.apiKey = apiKey;
      config.radarr.rootFolderPath = String(body.rootFolderPath || '').trim();
      config.radarr.qualityProfileId = body.qualityProfileId === '' || body.qualityProfileId == null
        ? null
        : Number(body.qualityProfileId);
      saveConfig(config);
      sendJson(req, res, 200, { ok: true, config: sanitizedConfig() });
      return;
    }
    if (req.method === 'GET' && pathname === '/radarr/status') {
      const result = await testRadarr(config.radarr.baseUrl, config.radarr.apiKey);
      sendJson(req, res, 200, { ok: true, version: result.version, config: sanitizedConfig().radarr });
      return;
    }
    if (req.method === 'GET' && pathname === '/radarr/defaults') {
      const result = await testRadarr(config.radarr.baseUrl, config.radarr.apiKey);
      sendJson(req, res, 200, {
        ok: true,
        rootFolders: result.rootFolders,
        qualityProfiles: result.qualityProfiles,
        config: sanitizedConfig().radarr,
      });
      return;
    }
    if (req.method === 'POST' && pathname === '/radarr/add') {
      const body = await readJson(req);
      const baseUrl = normalizeBaseUrl(config.radarr.baseUrl, 7878);
      const key = String(config.radarr.apiKey || '').trim();
      const tmdbId = Number(body.tmdbId);
      if (!baseUrl || !key) throw new Error('Radarr is not configured in PickFlick Bridge setup');
      if (!Number.isFinite(tmdbId)) throw new Error('A valid TMDB ID is required');
      let rootFolderPath = config.radarr.rootFolderPath;
      let qualityProfileId = config.radarr.qualityProfileId;
      const headers = { 'X-Api-Key': key, 'Content-Type': 'application/json' };
      if (!rootFolderPath || !qualityProfileId) {
        const defaults = await testRadarr(baseUrl, key);
        rootFolderPath ||= defaults.rootFolders[0]?.path || '';
        qualityProfileId ||= defaults.qualityProfiles[0]?.id || 1;
      }
      if (!rootFolderPath) throw new Error('No Radarr root folder is configured');
      const addPayload = {
        tmdbId,
        title: String(body.title || ''),
        qualityProfileId: Number(qualityProfileId) || 1,
        rootFolderPath,
        monitored: true,
        addOptions: { searchForMovie: true },
      };
      try {
        const data = await fetchJson(`${baseUrl}/api/v3/movie`, {
          method: 'POST',
          headers,
          body: JSON.stringify(addPayload),
        }, 30000);
        sendJson(req, res, 200, { ok: true, added: true, movie: data });
      } catch (e) {
        const bodyText = Array.isArray(e.body)
          ? e.body.map(item => item.errorMessage || item.message || '').join(' ')
          : JSON.stringify(e.body || '');
        if (e.status === 400 && /already/i.test(bodyText)) {
          sendJson(req, res, 200, { ok: true, alreadyExists: true });
          return;
        }
        throw e;
      }
      return;
    }

    sendJson(req, res, 404, { ok: false, error: 'Not found' });
  } catch (e) {
    const status = e.status === 401 ? 401 : 400;
    sendError(req, res, status, e);
  }
}

const port = Number(process.env.PICKFLICK_BRIDGE_PORT || config.bridge.port || DEFAULT_PORT);
const host = process.env.PICKFLICK_BRIDGE_HOST || config.bridge.host || DEFAULT_HOST;
config.bridge.port = port;
config.bridge.host = host;
saveConfig(config);

const server = http.createServer(route);
server.listen(port, host, () => {
  console.log(`PickFlick Bridge ${VERSION}`);
  console.log(`Setup: http://${host}:${port}/setup`);
  console.log(`Config: ${CONFIG_PATH}`);
});
