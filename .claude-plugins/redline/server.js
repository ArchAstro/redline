#!/usr/bin/env node
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');

const PORT = parseInt(process.env.REDLINE_PORT || '7878', 10);
const ROOT = process.env.REDLINE_DIR || path.join(os.homedir(), '.redline');
const DB = path.join(ROOT, 'redlines.json');
const SHOTS = path.join(ROOT, 'screenshots');
const AUTH_TOKEN_FILE = path.join(ROOT, 'auth-token');

fs.mkdirSync(SHOTS, { recursive: true });
if (!fs.existsSync(DB)) fs.writeFileSync(DB, '[]');

function readDB() {
  try {
    return JSON.parse(fs.readFileSync(DB, 'utf8'));
  } catch {
    return [];
  }
}

function writeDB(items) {
  const tmp = DB + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(items, null, 2));
  fs.renameSync(tmp, DB);
}

function mkid(prefix) {
  return `${prefix}_${Date.now().toString(36)}${crypto.randomBytes(4).toString('hex')}`;
}

function readBody(req, limitMB = 20) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    const limit = limitMB * 1024 * 1024;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('payload too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function requestOrigin(req) {
  return req.headers.origin || null;
}

function isAllowedOrigin(origin) {
  return !origin || /^chrome-extension:\/\/[a-z0-9]{8,}$/i.test(origin);
}

function extensionRequestIsAuthorized(req) {
  const origin = requestOrigin(req);
  if (!origin || req.method === 'OPTIONS') return true;
  let expected;
  try {
    expected = fs.readFileSync(AUTH_TOKEN_FILE, 'utf8').trim();
  } catch {
    return false;
  }
  const provided = req.headers['x-redline-token'];
  if (typeof provided !== 'string' || !expected) return false;
  const expectedBuffer = Buffer.from(expected);
  const providedBuffer = Buffer.from(provided);
  return expectedBuffer.length === providedBuffer.length &&
    crypto.timingSafeEqual(expectedBuffer, providedBuffer);
}

function corsHeaders(req, headers = {}) {
  const origin = requestOrigin(req);
  if (!origin) return headers;
  return {
    'access-control-allow-origin': origin,
    'access-control-allow-methods': 'GET,POST,PATCH,DELETE,OPTIONS',
    'access-control-allow-headers': 'content-type, x-redline-token',
    vary: 'Origin',
    ...headers,
  };
}

function send(req, res, status, body, headers = {}) {
  const isBuf = Buffer.isBuffer(body);
  const data = isBuf || typeof body === 'string' ? body : JSON.stringify(body);
  res.writeHead(status, {
    'content-type': isBuf ? (headers['content-type'] || 'application/octet-stream') : 'application/json',
    ...corsHeaders(req, headers),
  });
  res.end(data);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const route = `${req.method} ${url.pathname}`;

  if (!isAllowedOrigin(requestOrigin(req))) {
    res.writeHead(403, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ error: 'forbidden origin' }));
  }

  if (req.method === 'OPTIONS') return send(req, res, 204, '');

  if (route !== 'GET /health' && !extensionRequestIsAuthorized(req)) {
    return send(req, res, 401, { error: 'missing or invalid Redline capability token' });
  }

  try {
    if (route === 'GET /health') {
      return send(req, res, 200, { ok: true, port: PORT, db: DB, screenshots: SHOTS });
    }

    if (route === 'POST /redlines') {
      const body = JSON.parse((await readBody(req)).toString('utf8'));
      const item = {
        id: mkid('rl'),
        created_at: new Date().toISOString(),
        status: 'pending',
        url: body.url || null,
        origin: body.origin || null,
        title: body.title || null,
        project: body.project || null,
        selected_text: body.selected_text || '',
        comment: body.comment || '',
        context: body.context || null,
        screenshot_id: body.screenshot_id || null,
        rect: body.rect || null,
      };
      const items = readDB();
      items.push(item);
      writeDB(items);
      return send(req, res, 201, item);
    }

    if (route === 'GET /redlines') {
      const status = url.searchParams.get('status');
      const origin = url.searchParams.get('origin');
      const project = url.searchParams.get('project');
      let items = readDB();
      if (status) items = items.filter((i) => i.status === status);
      if (origin) items = items.filter((i) => i.origin === origin);
      if (project) items = items.filter((i) => i.project === project);
      return send(req, res, 200, items);
    }

    const ackMatch = url.pathname.match(/^\/redlines\/([^/]+)\/ack$/);
    if (req.method === 'POST' && ackMatch) {
      const items = readDB();
      const item = items.find((i) => i.id === ackMatch[1]);
      if (!item) return send(req, res, 404, { error: 'not found' });
      item.status = 'acked';
      item.acked_at = new Date().toISOString();
      writeDB(items);
      return send(req, res, 200, item);
    }

    const updateMatch = url.pathname.match(/^\/redlines\/([^/]+)$/);
    if (req.method === 'PATCH' && updateMatch) {
      const body = JSON.parse((await readBody(req)).toString('utf8'));
      const items = readDB();
      const item = items.find((i) => i.id === updateMatch[1]);
      if (!item) return send(req, res, 404, { error: 'not found' });
      for (const field of ['url', 'origin', 'title', 'project', 'selected_text', 'comment', 'context', 'screenshot_id', 'rect']) {
        if (Object.prototype.hasOwnProperty.call(body, field)) item[field] = body[field] || null;
      }
      if (Object.prototype.hasOwnProperty.call(body, 'selected_text')) item.selected_text = body.selected_text || '';
      if (Object.prototype.hasOwnProperty.call(body, 'comment')) item.comment = body.comment || '';
      item.updated_at = new Date().toISOString();
      writeDB(items);
      return send(req, res, 200, item);
    }

    const delMatch = url.pathname.match(/^\/redlines\/([^/]+)$/);
    if (req.method === 'DELETE' && delMatch) {
      writeDB(readDB().filter((i) => i.id !== delMatch[1]));
      return send(req, res, 204, '');
    }

    if (route === 'POST /screenshots') {
      const body = JSON.parse((await readBody(req)).toString('utf8'));
      const m = (body.data_url || '').match(/^data:image\/png;base64,(.+)$/);
      if (!m) return send(req, res, 400, { error: 'expected { data_url: "data:image/png;base64,..." }' });
      const buf = Buffer.from(m[1], 'base64');
      const id = mkid('ss');
      fs.writeFileSync(path.join(SHOTS, id + '.png'), buf);
      return send(req, res, 201, { id, bytes: buf.length });
    }

    const shotMatch = url.pathname.match(/^\/screenshots\/([^/]+)$/);
    if (req.method === 'GET' && shotMatch) {
      const file = path.join(SHOTS, shotMatch[1].replace(/\.png$/, '') + '.png');
      if (!fs.existsSync(file)) return send(req, res, 404, { error: 'not found' });
      return send(req, res, 200, fs.readFileSync(file), { 'content-type': 'image/png' });
    }

    send(req, res, 404, { error: 'not found', route });
  } catch (e) {
    send(req, res, 500, { error: e.message });
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`redline sidecar listening on http://127.0.0.1:${PORT}`);
  console.log(`data dir: ${ROOT}`);
});
