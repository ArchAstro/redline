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

function send(res, status, body, headers = {}) {
  const isBuf = Buffer.isBuffer(body);
  const data = isBuf || typeof body === 'string' ? body : JSON.stringify(body);
  res.writeHead(status, {
    'content-type': isBuf ? (headers['content-type'] || 'application/octet-stream') : 'application/json',
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET,POST,DELETE,OPTIONS',
    'access-control-allow-headers': 'content-type',
    ...headers,
  });
  res.end(data);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const route = `${req.method} ${url.pathname}`;

  if (req.method === 'OPTIONS') return send(res, 204, '');

  try {
    if (route === 'GET /health') {
      return send(res, 200, { ok: true, port: PORT, db: DB, screenshots: SHOTS });
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
      return send(res, 201, item);
    }

    if (route === 'GET /redlines') {
      const status = url.searchParams.get('status');
      const origin = url.searchParams.get('origin');
      const project = url.searchParams.get('project');
      let items = readDB();
      if (status) items = items.filter((i) => i.status === status);
      if (origin) items = items.filter((i) => i.origin === origin);
      if (project) items = items.filter((i) => i.project === project);
      return send(res, 200, items);
    }

    const ackMatch = url.pathname.match(/^\/redlines\/([^/]+)\/ack$/);
    if (req.method === 'POST' && ackMatch) {
      const items = readDB();
      const item = items.find((i) => i.id === ackMatch[1]);
      if (!item) return send(res, 404, { error: 'not found' });
      item.status = 'acked';
      item.acked_at = new Date().toISOString();
      writeDB(items);
      return send(res, 200, item);
    }

    const delMatch = url.pathname.match(/^\/redlines\/([^/]+)$/);
    if (req.method === 'DELETE' && delMatch) {
      writeDB(readDB().filter((i) => i.id !== delMatch[1]));
      return send(res, 204, '');
    }

    if (route === 'POST /screenshots') {
      const body = JSON.parse((await readBody(req)).toString('utf8'));
      const m = (body.data_url || '').match(/^data:image\/png;base64,(.+)$/);
      if (!m) return send(res, 400, { error: 'expected { data_url: "data:image/png;base64,..." }' });
      const buf = Buffer.from(m[1], 'base64');
      const id = mkid('ss');
      fs.writeFileSync(path.join(SHOTS, id + '.png'), buf);
      return send(res, 201, { id, bytes: buf.length });
    }

    const shotMatch = url.pathname.match(/^\/screenshots\/([^/]+)$/);
    if (req.method === 'GET' && shotMatch) {
      const file = path.join(SHOTS, shotMatch[1].replace(/\.png$/, '') + '.png');
      if (!fs.existsSync(file)) return send(res, 404, { error: 'not found' });
      return send(res, 200, fs.readFileSync(file), { 'content-type': 'image/png' });
    }

    send(res, 404, { error: 'not found', route });
  } catch (e) {
    send(res, 500, { error: e.message });
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`redline sidecar listening on http://127.0.0.1:${PORT}`);
  console.log(`data dir: ${ROOT}`);
});
