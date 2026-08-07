#!/usr/bin/env node
'use strict';

const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { readPrivateCredential } = require('./auth');
const { parsePort } = require('./protocol');

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

class CliCredentialError extends Error {}

function requestWithCliCredential({
  dataRoot = path.resolve(process.env.REDLINE_DIR || path.join(os.homedir(), '.redline')),
  port: portRaw,
  method,
  requestPath,
  body,
  timeoutMs = 3000,
  maxResponseBytes = 25 * 1024 * 1024,
} = {}) {
  const port = parsePort(String(portRaw));
  if (!['GET', 'POST', 'PATCH', 'DELETE'].includes(method) || typeof requestPath !== 'string' ||
      !requestPath.startsWith('/') || requestPath.length > 8192 || /[\0\r\n]/.test(requestPath)) {
    throw new Error('Redline CLI request configuration is invalid');
  }
  const payload = body === undefined ? null : Buffer.from(body);
  let token;
  try { token = readPrivateCredential(path.join(path.resolve(dataRoot), 'cli-credential')); } catch {
    throw new CliCredentialError('Redline CLI credential is missing or unsafe');
  }
  return new Promise((resolve, reject) => {
    const headers = { authorization: `Bearer ${token}` };
    if (payload) {
      headers['content-type'] = 'application/json';
      headers['content-length'] = payload.length;
    }
    const request = http.request({ hostname: '127.0.0.1', port, method, path: requestPath, headers }, (response) => {
      const chunks = [];
      let size = 0;
      response.on('data', (chunk) => {
        size += chunk.length;
        if (size > maxResponseBytes) request.destroy(new Error('Redline response is too large'));
        else chunks.push(chunk);
      });
      response.on('end', () => resolve({ statusCode: response.statusCode, body: Buffer.concat(chunks) }));
    });
    request.setTimeout(timeoutMs, () => request.destroy(new Error('Redline sidecar request timed out')));
    request.on('error', reject);
    request.end(payload || undefined);
  });
}

async function main() {
  const [port, method, requestPath] = process.argv.slice(2);
  let response;
  try {
    response = await requestWithCliCredential({ port, method, requestPath });
  } catch (error) {
    if (error instanceof CliCredentialError) {
      fail('Redline CLI credential is missing or unsafe; rerun redline setup.');
    }
    fail('Redline sidecar request failed.');
  }
  if (response.statusCode < 200 || response.statusCode >= 300) {
    fail(`Redline request failed (HTTP ${response.statusCode}).`);
  }
  process.stdout.write(response.body);
}

if (require.main === module) main();

module.exports = { CliCredentialError, requestWithCliCredential };
