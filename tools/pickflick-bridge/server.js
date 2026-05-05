// PickFlick Bridge
// Local-only bridge for GitHub Pages -> LM Studio / Radarr.
// No external npm dependencies.

'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');

const VERSION = '0.1.11';
const DEFAULT_PORT = 8765;
const DEFAULT_LISTEN_HOST = '0.0.0.0';
const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_LM_TTL_SECONDS = 10 * 60;
const PUBLIC_DIR = path.join(__dirname, 'public');
const PICKFLICK_DIR = path.join(__dirname, 'pickflick');
const DATA_DIR = process.env.PICKFLICK_BRIDGE_DATA
  || path.join(process.env.LOCALAPPDATA || os.homedir(), 'PickFlickBridge');
const DB_PATH = process.env.PICKFLICK_BRIDGE_DB
  || path.join(DATA_DIR, 'settings.db.json');
const CONFIG_PATH = process.env.PICKFLICK_BRIDGE_CONFIG
  || path.join(DATA_DIR, 'config.json');
const DB_SCHEMA = 'pickflick-bridge-settings';
const DB_VERSION = 1;

const ALLOWED_ORIGINS = new Set([
  'https://jessomadic.github.io',
  'https://jessecopas.com',
  'https://www.jessecopas.com',
  'http://127.0.0.1',
  'http://localhost',
]);

const FEATURES = {
  lmStudioApiKey: true,
  lmStudioModelEndpoints: ['/v1/models', '/api/v1/models', '/api/v0/models'],
  radarrSavedApiKey: true,
  radarrSetup: true,
  setupUrlParsing: true,
  bridgeHostConfig: true,
  radarrPreflight: true,
  persistentSettingsDb: true,
};

function localIpv4Hosts() {
  return Object.values(os.networkInterfaces())
    .flat()
    .filter(iface => iface && iface.family === 'IPv4' && !iface.internal)
    .map(iface => iface.address)
    .filter(address => address && !address.startsWith('169.254.'))
    .sort((a, b) => {
      const aPreferred = /^192\.168\./.test(a) ? 0 : 1;
      const bPreferred = /^192\.168\./.test(b) ? 0 : 1;
      return aPreferred - bPreferred || a.localeCompare(b, undefined, { numeric: true });
    });
}

function defaultPublicHost() {
  return localIpv4Hosts()[0] || DEFAULT_HOST;
}

function isWildcardHost(host) {
  return ['0.0.0.0', '::', '*'].includes(String(host || '').trim());
}

function normalizeHost(input, fallback = DEFAULT_HOST, { allowWildcard = false } = {}) {
  const raw = String(input || '').trim();
  if (!raw) return fallback;
  if (allowWildcard && isWildcardHost(raw)) return '0.0.0.0';
  const source = /^https?:\/\//i.test(raw) ? raw : `http://${raw}`;
  try {
    const parsed = new URL(source);
    const host = parsed.hostname.replace(/^\[(.*)]$/, '$1');
    if (!host || (!allowWildcard && isWildcardHost(host))) return fallback;
    return host;
  } catch {
    return fallback;
  }
}

function normalizePort(input, fallback = DEFAULT_PORT) {
  const port = Number(input);
  return Number.isInteger(port) && port >= 1 && port <= 65535 ? port : fallback;
}

function normalizeTtlSeconds(value, fallback = DEFAULT_LM_TTL_SECONDS) {
  const ttl = Number(value);
  if (!Number.isFinite(ttl)) return fallback;
  return Math.max(60, Math.min(24 * 60 * 60, Math.round(ttl)));
}

function localSetupHost(listenHost) {
  const host = String(listenHost || '').trim();
  if (!host || isWildcardHost(host) || host === '::1') return DEFAULT_HOST;
  return host;
}

function ensureDataDir() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

function readJsonFile(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, ''));
}

function backupFile(filePath, suffix = 'bak') {
  if (!fs.existsSync(filePath)) return null;
  const backupPath = `${filePath}.${suffix}.${timestampForFile()}`;
  fs.copyFileSync(filePath, backupPath);
  return backupPath;
}

function timestampForFile() {
  return new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14);
}

function pruneBackups(filePath, keep = 8) {
  const dir = path.dirname(filePath);
  const base = path.basename(filePath);
  const backups = fs.readdirSync(dir)
    .filter(name => name.startsWith(`${base}.bak.`))
    .map(name => ({
      name,
      path: path.join(dir, name),
      mtimeMs: fs.statSync(path.join(dir, name)).mtimeMs,
    }))
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
  backups.slice(keep).forEach(entry => {
    try { fs.unlinkSync(entry.path); } catch { /* best effort */ }
  });
}

function atomicWriteJson(filePath, data) {
  ensureDataDir();
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  if (fs.existsSync(filePath)) {
    backupFile(filePath);
    pruneBackups(filePath);
  }
  const tempPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  const payload = JSON.stringify(data, null, 2);
  const fd = fs.openSync(tempPath, 'w');
  try {
    fs.writeFileSync(fd, payload, 'utf8');
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tempPath, filePath);
}

function unwrapSettingsDocument(doc) {
  if (doc?.schema === DB_SCHEMA && doc?.data) return doc.data;
  if (doc?.data?.bridge || doc?.data?.lmStudio || doc?.data?.radarr) return doc.data;
  return doc;
}

function defaultConfig() {
  return {
    bridge: {
      host: defaultPublicHost(),
      listenHost: DEFAULT_LISTEN_HOST,
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
  let loaded = null;
  let source = 'default';

  try {
    if (fs.existsSync(DB_PATH)) {
      loaded = unwrapSettingsDocument(readJsonFile(DB_PATH));
      source = 'db';
    }
  } catch (e) {
    backupFile(DB_PATH, 'corrupt');
    console.error(`Could not read settings database ${DB_PATH}: ${e.message}`);
  }

  if (!loaded) {
    try {
      if (fs.existsSync(CONFIG_PATH)) {
        loaded = readJsonFile(CONFIG_PATH);
        source = 'legacy config';
      }
    } catch (e) {
      backupFile(CONFIG_PATH, 'corrupt');
      console.error(`Could not read legacy config ${CONFIG_PATH}: ${e.message}`);
    }
  }

  const merged = mergeConfig(defaultConfig(), loaded || {});
  if (source !== 'db') saveConfig(merged);
  return merged;
}

function mergeConfig(base, loaded) {
  const loadedBridge = loaded.bridge || {};
  const bridge = {
    ...base.bridge,
    ...loadedBridge,
  };
  bridge.port = normalizePort(bridge.port, DEFAULT_PORT);
  bridge.host = normalizeHost(bridge.host, defaultPublicHost());
  bridge.listenHost = normalizeHost(bridge.listenHost, DEFAULT_LISTEN_HOST, { allowWildcard: true });

  return {
    ...base,
    ...loaded,
    bridge,
    lmStudio: { ...base.lmStudio, ...(loaded.lmStudio || {}) },
    radarr: { ...base.radarr, ...(loaded.radarr || {}) },
  };
}

function saveConfig(config) {
  const merged = mergeConfig(defaultConfig(), config || {});
  atomicWriteJson(DB_PATH, {
    schema: DB_SCHEMA,
    version: DB_VERSION,
    updatedAt: new Date().toISOString(),
    data: merged,
  });
  return merged;
}

let config = loadConfig();

function sanitizedConfig() {
  const port = normalizePort(config.bridge.port, DEFAULT_PORT);
  const publicHost = normalizeHost(config.bridge.host, defaultPublicHost());
  const listenHost = normalizeHost(config.bridge.listenHost, DEFAULT_LISTEN_HOST, { allowWildcard: true });
  return {
    bridge: {
      host: publicHost,
      listenHost,
      port,
      bridgeUrl: `http://${publicHost}:${port}`,
      setupUrl: `http://${publicHost}:${port}/setup`,
      localSetupUrl: `http://${localSetupHost(listenHost)}:${port}/setup`,
      networkHosts: localIpv4Hosts(),
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
    res.setHeader('Vary', 'Origin, Access-Control-Request-Private-Network');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Access-Control-Allow-Private-Network', 'true');
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
        const authError = new Error('LM Studio returned HTTP 401. If authentication is enabled in LM Studio Server Settings, paste an LM Studio API token here and test again.');
        authError.status = 401;
        throw authError;
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

async function getRadarrMovieByTmdbId(baseUrl, headers, tmdbId) {
  const movies = await fetchJson(`${baseUrl}/api/v3/movie`, { headers }, 15000);
  if (!Array.isArray(movies)) return null;
  return movies.find(movie => Number(movie.tmdbId) === Number(tmdbId)) || null;
}

function chooseRadarrDefaults(result, savedRootFolderPath, savedQualityProfileId) {
  const rootFolders = Array.isArray(result.rootFolders) ? result.rootFolders : [];
  const qualityProfiles = Array.isArray(result.qualityProfiles) ? result.qualityProfiles : [];
  const rootFolder = rootFolders.find(folder => folder.path === savedRootFolderPath) || rootFolders[0];
  const qualityProfile = qualityProfiles.find(profile => Number(profile.id) === Number(savedQualityProfileId)) || qualityProfiles[0];
  return {
    rootFolderPath: rootFolder?.path || '',
    qualityProfileId: qualityProfile?.id ?? null,
    rootFolder,
    qualityProfile,
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
  if (ext === '.png') return 'image/png';
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  if (ext === '.webp') return 'image/webp';
  if (ext === '.ico') return 'image/x-icon';
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
    if (req.method === 'GET' && pathname === '/pickflick') {
      res.writeHead(302, { Location: '/pickflick/' });
      res.end();
      return;
    }
    if (req.method === 'GET' && pathname.startsWith('/pickflick/')) {
      const relativePath = decodeURIComponent(pathname.replace(/^\/pickflick\/?/, '')) || 'index.html';
      const target = path.resolve(PICKFLICK_DIR, relativePath);
      if (!target.startsWith(`${PICKFLICK_DIR}${path.sep}`)) throw new Error('Invalid PickFlick static path');
      staticFile(target, mimeFor(target), res);
      return;
    }
    if (req.method === 'GET' && pathname === '/health') {
      sendJson(req, res, 200, {
        ok: true,
        name: 'PickFlick Bridge',
        version: VERSION,
        features: FEATURES,
        config: sanitizedConfig(),
      });
      return;
    }
    if (req.method === 'GET' && pathname === '/api/config') {
      sendJson(req, res, 200, { ok: true, config: sanitizedConfig() });
      return;
    }
    if (req.method === 'POST' && pathname === '/api/bridge/save') {
      const body = await readJson(req);
      const previousPort = normalizePort(config.bridge.port, DEFAULT_PORT);
      const previousListenHost = normalizeHost(config.bridge.listenHost, DEFAULT_LISTEN_HOST, { allowWildcard: true });
      config.bridge.host = normalizeHost(body.host, config.bridge.host || defaultPublicHost());
      config.bridge.listenHost = normalizeHost(body.listenHost, config.bridge.listenHost || DEFAULT_LISTEN_HOST, { allowWildcard: true });
      config.bridge.port = normalizePort(body.port, previousPort);
      saveConfig(config);
      const restartRequired =
        previousPort !== config.bridge.port ||
        previousListenHost !== config.bridge.listenHost;
      sendJson(req, res, 200, { ok: true, restartRequired, config: sanitizedConfig() });
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
        temperature: Number.isFinite(body.temperature) ? body.temperature : 0.15,
        max_tokens: Number.isFinite(body.maxTokens) ? body.maxTokens : 4096,
        ttl: normalizeTtlSeconds(body.ttl ?? body.ttlSeconds),
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
      const apiKey = body.apiKey ? String(body.apiKey).trim() : config.radarr.apiKey;
      const result = await testRadarr(body.baseUrl, apiKey);
      sendJson(req, res, 200, { ok: true, ...result });
      return;
    }
    if (req.method === 'POST' && pathname === '/api/radarr/save') {
      const body = await readJson(req);
      const baseUrl = normalizeBaseUrl(body.baseUrl, 7878);
      const apiKey = body.apiKey ? String(body.apiKey).trim() : config.radarr.apiKey;
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
      const defaults = chooseRadarrDefaults(result, config.radarr.rootFolderPath, config.radarr.qualityProfileId);
      sendJson(req, res, 200, {
        ok: true,
        version: result.version,
        rootFolderReady: !!defaults.rootFolderPath,
        qualityProfileReady: defaults.qualityProfileId != null,
        config: sanitizedConfig().radarr,
      });
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
    if (req.method === 'POST' && pathname === '/radarr/validate') {
      const body = await readJson(req);
      const baseUrl = normalizeBaseUrl(config.radarr.baseUrl, 7878);
      const key = String(config.radarr.apiKey || '').trim();
      const tmdbId = body.tmdbId == null ? null : Number(body.tmdbId);
      if (!baseUrl || !key) throw new Error('Radarr is not configured in PickFlick Bridge setup');
      const result = await testRadarr(baseUrl, key);
      const defaults = chooseRadarrDefaults(result, config.radarr.rootFolderPath, config.radarr.qualityProfileId);
      if (!defaults.rootFolderPath) throw new Error('No Radarr root folder is configured');
      if (defaults.qualityProfileId == null) throw new Error('No Radarr quality profile is configured');
      let existing = null;
      if (Number.isFinite(tmdbId)) {
        existing = await getRadarrMovieByTmdbId(baseUrl, { 'X-Api-Key': key }, tmdbId);
      }
      sendJson(req, res, 200, {
        ok: true,
        version: result.version,
        rootFolderPath: defaults.rootFolderPath,
        qualityProfileId: defaults.qualityProfileId,
        existing: existing ? { title: existing.title, tmdbId: existing.tmdbId } : null,
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
      const existing = await getRadarrMovieByTmdbId(baseUrl, { 'X-Api-Key': key }, tmdbId);
      if (existing) {
        sendJson(req, res, 200, { ok: true, alreadyExists: true, movie: { title: existing.title, tmdbId: existing.tmdbId } });
        return;
      }
      if (!rootFolderPath || !qualityProfileId) {
        const defaults = await testRadarr(baseUrl, key);
        const chosen = chooseRadarrDefaults(defaults, rootFolderPath, qualityProfileId);
        rootFolderPath = chosen.rootFolderPath;
        qualityProfileId = chosen.qualityProfileId;
      }
      if (!rootFolderPath) throw new Error('No Radarr root folder is configured');
      if (qualityProfileId == null) throw new Error('No Radarr quality profile is configured');
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

const port = normalizePort(process.env.PICKFLICK_BRIDGE_PORT || config.bridge.port, DEFAULT_PORT);
const listenHost = normalizeHost(
  process.env.PICKFLICK_BRIDGE_LISTEN_HOST || config.bridge.listenHost,
  DEFAULT_LISTEN_HOST,
  { allowWildcard: true },
);
const host = normalizeHost(process.env.PICKFLICK_BRIDGE_HOST || config.bridge.host, defaultPublicHost());
config.bridge.port = port;
config.bridge.host = host;
config.bridge.listenHost = listenHost;
saveConfig(config);

const server = http.createServer(route);
server.listen(port, listenHost, () => {
  console.log(`PickFlick Bridge ${VERSION}`);
  console.log(`Listening: http://${listenHost}:${port}`);
  console.log(`Setup: http://${localSetupHost(listenHost)}:${port}/setup`);
  console.log(`PickFlick URL: http://${host}:${port}`);
  console.log(`Config: ${CONFIG_PATH}`);
});
