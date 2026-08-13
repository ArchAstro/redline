#!/usr/bin/env node
// Install / update / uninstall the Redline Chrome extension.
// Designed to be run via:
//
//   npx -p @archastro/redline redline-agent-setup
//
// or, after a global install, just `redline-agent-setup`. Zero deps.

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const os = require('os');
const http = require('http');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const { CliCredentialError, requestWithCliCredential } = require('../runtime/lib/cli-http');
const { loadExtensionIdentity, validExtensionId } = require('../runtime/lib/extension-identity');
const { healthProbe } = require('../runtime/lib/sidecar-lifecycle');
const { findInstalledExtension, inspectInstalledExtension } = require('./chrome-profile-discovery');
const { assertSupportedPlatform, openBrowser } = require('./open-browser');

const FULL_ACCESS_PATTERN = '<all_urls>';

const ANSI = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  bold: '\x1b[1m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  cyan: '\x1b[36m',
};

function color(c, s) {
  return process.stdout.isTTY ? `${ANSI[c]}${s}${ANSI.reset}` : s;
}

function log(msg) {
  process.stdout.write(msg + '\n');
}

function warn(msg) {
  process.stderr.write(color('yellow', 'warning: ') + msg + '\n');
}

function fail(msg) {
  process.stderr.write(color('red', 'error: ') + msg + '\n');
  process.exit(1);
}

function parseArgs(argv) {
  const opts = {
    uninstall: false,
    dryRun: false,
    source: null,
    help: false,
    extensionStatus: false,
    withScreenshots: false,
    localOnly: false,
  };
  const args = argv.slice(2);
  if (path.basename(argv[1] || '') === 'redline-extension-status') {
    opts.extensionStatus = true;
  }
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    switch (a) {
      case '--claude-only':
      case '--codex-only':
        fail(`${a} was removed; manage agent skills directly with npx skills`);
        break;
      case '--uninstall': case '--remove': opts.uninstall = true; break;
      case '--dry-run': opts.dryRun = true; break;
      case '--extension-status': opts.extensionStatus = true; break;
      case '--with-screenshots': opts.withScreenshots = true; break;
      case '--local-only': opts.localOnly = true; break;
      case '--source':
      case '--plugin-source': {
        const value = args[i + 1];
        if (!value || value.startsWith('-')) fail(`${a} requires a path value`);
        opts.source = value;
        i++;
        break;
      }
      case '-h': case '--help': opts.help = true; break;
      default:
        if (a.startsWith('--source=')) {
          const value = a.slice('--source='.length);
          if (!value) fail('--source requires a path value');
          opts.source = value;
        } else if (a.startsWith('--plugin-source=')) {
          const value = a.slice('--plugin-source='.length);
          if (!value) fail('--plugin-source requires a path value');
          opts.source = value;
        } else {
          fail(`unknown arg: ${a} (try --help)`);
        }
    }
  }
  if (opts.withScreenshots && opts.localOnly) {
    fail('pass at most one of --with-screenshots and --local-only');
  }
  return opts;
}

function printHelp() {
  log(`redline-agent-setup - configure the Redline Chrome extension

Usage:
  redline-agent-setup                # start helper and pair Store extension
  redline-agent-setup --extension-status
                                   # check extension presence + helper health

Chrome Web Store:
  Install Redline from the Chrome Web Store, then run this command. It opens
  a short-lived local consent page used to pair the extension with the helper.

Unpacked development only:
  redline-agent-setup --dry-run      # print what would change without writing
  redline-agent-setup --with-screenshots
                                   # enable full page access for screenshots
  redline-agent-setup --local-only   # switch back to the low-permission mode
  redline-agent-setup --uninstall    # remove generated unpacked extension

Options:
  --source PATH          Override the package source dir (development/testing).
  -h, --help             Show this help.

Agent skills are user-managed. Install or remove the Redline skill directly
with the standard npx skills CLI.
`);
}

function resolvePackageRoot() {
  // setup/redline-agent-setup.js lives at <pkg>/setup/, so the package root
  // is one level up.
  return path.resolve(__dirname, '..');
}

function missingRequiredCommands(commands) {
  return commands.filter((command) => {
    const result = spawnSync(command, ['--version'], { stdio: 'ignore' });
    return result.error || result.status !== 0;
  });
}

async function exists(p) {
  try { await fsp.access(p); return true; } catch { return false; }
}

async function readJsonOrNull(p) {
  try {
    return JSON.parse(await fsp.readFile(p, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    if (error instanceof SyntaxError) throw new Error(`invalid JSON in ${p}: ${error.message}`);
    throw error;
  }
}

async function writeFileIfChanged(p, content, dryRun) {
  const existing = (await exists(p)) ? await fsp.readFile(p, 'utf8') : null;
  if (existing === content) return false;
  if (!dryRun) {
    await fsp.mkdir(path.dirname(p), { recursive: true });
    const mode = existing === null ? 0o600 : (await fsp.stat(p)).mode & 0o777;
    const tmp = `${p}.tmp-${process.pid}-${crypto.randomBytes(6).toString('hex')}`;
    let handle;
    try {
      handle = await fsp.open(tmp, 'wx', mode);
      await handle.writeFile(content);
      await handle.sync();
      await handle.close();
      handle = null;
      await fsp.rename(tmp, p);
    } finally {
      if (handle) await handle.close().catch(() => {});
      await fsp.rm(tmp, { force: true }).catch(() => {});
    }
  }
  return true;
}

async function walk(root) {
  const out = [];
  async function rec(dir) {
    const entries = await fsp.readdir(dir, { withFileTypes: true });
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) await rec(full);
      else if (e.isFile()) out.push(full);
    }
  }
  if (await exists(root)) await rec(root);
  return out;
}

async function copyTree(src, dst, dryRun, transforms = {}, modeOverrides = {}, excluded = new Set()) {
  let changed = false;
  const wanted = new Set();
  const files = await walk(src);
  for (const file of files) {
    const rel = path.relative(src, file);
    if (excluded.has(rel)) continue;
    wanted.add(rel);
    const target = path.join(dst, rel);
    let srcBuf = await fsp.readFile(file);
    if (transforms[rel]) {
      srcBuf = Buffer.from(transforms[rel](srcBuf.toString('utf8')), 'utf8');
    }
    const sourceMode = modeOverrides[rel] ?? ((await fsp.stat(file)).mode & 0o777);
    const targetExists = await exists(target);
    const dstBuf = targetExists ? await fsp.readFile(target) : null;
    const contentChanged = !dstBuf || !srcBuf.equals(dstBuf);
    const modeChanged = !targetExists || ((await fsp.stat(target)).mode & 0o777) !== sourceMode;
    if (contentChanged || modeChanged) {
      changed = true;
      if (!dryRun) {
        await fsp.mkdir(path.dirname(target), { recursive: true });
        if (contentChanged) await fsp.writeFile(target, srcBuf);
        if (modeChanged) await fsp.chmod(target, sourceMode);
      }
    }
  }
  // Prune extraneous files in dst (don't touch dirs — fine to leave).
  if (await exists(dst)) {
    for (const dstFile of await walk(dst)) {
      const rel = path.relative(dst, dstFile);
      if (!wanted.has(rel)) {
        changed = true;
        if (!dryRun) await fsp.rm(dstFile, { force: true });
      }
    }
  }
  return changed;
}

function redlineRoot() {
  return path.join(os.homedir(), '.redline');
}

function redlineDataRoot() {
  return process.env.REDLINE_DIR ? path.resolve(process.env.REDLINE_DIR) : redlineRoot();
}

function redlinePort() {
  const port = Number.parseInt(process.env.REDLINE_PORT || '7878', 10);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('REDLINE_PORT must be an integer between 1 and 65535');
  }
  return port;
}

function configPath() {
  return path.join(redlineRoot(), 'config.json');
}

function authTokenPath() {
  return path.join(redlineDataRoot(), 'auth-token');
}

async function readAuthToken() {
  try {
    const token = (await fsp.readFile(authTokenPath(), 'utf8')).trim();
    return token.length >= 43 ? token : null;
  } catch {
    return null;
  }
}

async function ensureAuthToken(dryRun) {
  const existing = await readAuthToken();
  if (existing) {
    if (!dryRun) {
      await fsp.chmod(redlineDataRoot(), 0o700);
      await fsp.chmod(authTokenPath(), 0o600);
    }
    return existing;
  }
  const token = crypto.randomBytes(32).toString('base64url');
  if (!dryRun) {
    await fsp.mkdir(redlineDataRoot(), { recursive: true, mode: 0o700 });
    await fsp.chmod(redlineDataRoot(), 0o700);
    await fsp.writeFile(authTokenPath(), token + '\n', { mode: 0o600 });
    await fsp.chmod(authTokenPath(), 0o600);
  }
  return token;
}

function patchExtensionAuth(raw, token, port) {
  if (!raw.includes('__REDLINE_AUTH_TOKEN__') || !raw.includes('__REDLINE_PORT__')) {
    throw new Error('extension auth template is missing a runtime configuration placeholder');
  }
  return raw
    .replace('__REDLINE_AUTH_TOKEN__', token)
    .replace('__REDLINE_PORT__', String(port));
}

function patchExtensionBackground(raw) {
  if (/importScripts\(['"]auth\.js['"]\)/.test(raw)) {
    throw new Error('store extension background must not import generated auth directly');
  }
  return `importScripts('auth.js');\n${raw}`;
}

async function readRedlineConfig() {
  const config = await readJsonOrNull(configPath());
  return config && typeof config === 'object' && !Array.isArray(config) ? config : {};
}

async function writeExtensionMode(mode, dryRun) {
  const config = await readRedlineConfig();
  const next = { ...config, extensionMode: mode };
  return writeFileIfChanged(configPath(), JSON.stringify(next, null, 2) + '\n', dryRun);
}

async function resolveExtensionMode(opts) {
  if (opts.withScreenshots) return 'full';
  if (opts.localOnly) return 'local';
  const config = await readRedlineConfig();
  return config.extensionMode === 'full' ? 'full' : 'local';
}

function extensionModeLabel(mode) {
  return mode === 'full' ? 'full-access' : 'local-only';
}

function patchExtensionManifestForMode(raw, mode, publicKey) {
  const manifest = JSON.parse(raw);
  if (publicKey) manifest.key = publicKey;
  if (mode !== 'full') return JSON.stringify(manifest, null, 2) + '\n';

  const hostPermissions = Array.isArray(manifest.host_permissions) ? manifest.host_permissions : [];
  manifest.host_permissions = Array.from(new Set([...hostPermissions, FULL_ACCESS_PATTERN]));

  if (Array.isArray(manifest.content_scripts)) {
    manifest.content_scripts = manifest.content_scripts.map((script) => ({
      ...script,
      matches: Array.from(new Set([...(Array.isArray(script.matches) ? script.matches : []), FULL_ACCESS_PATTERN])),
    }));
  }

  return JSON.stringify(manifest, null, 2) + '\n';
}

function detectScreenshotMode(manifest) {
  const hosts = Array.isArray(manifest?.host_permissions) ? manifest.host_permissions : [];
  const contentScripts = Array.isArray(manifest?.content_scripts) ? manifest.content_scripts : [];
  const contentMatches = contentScripts.flatMap((script) => Array.isArray(script.matches) ? script.matches : []);
  return hosts.includes(FULL_ACCESS_PATTERN) && contentMatches.includes(FULL_ACCESS_PATTERN) ? 'full' : 'local';
}

async function syncExtension(sourceRoot, dryRun, mode) {
  const extSrc = path.join(sourceRoot, 'extension');
  const extDst = path.join(redlineRoot(), 'extension');
  if (!(await exists(extSrc))) throw new Error(`Chrome extension source missing at ${extSrc}`);
  const devManifest = await fsp.readFile(path.join(extSrc, 'manifest.dev.json'), 'utf8');
  const { publicKey } = loadStoreIdentity(sourceRoot);
  const authToken = await ensureAuthToken(dryRun);
  const port = redlinePort();
  const filesChanged = await copyTree(extSrc, extDst, dryRun, {
    'manifest.json': () => patchExtensionManifestForMode(devManifest, mode, publicKey),
    'auth.js': (raw) => patchExtensionAuth(raw, authToken, port),
    'background.js': patchExtensionBackground,
  }, { 'auth.js': 0o600 }, new Set(['manifest.dev.json']));
  if (!dryRun) {
    await fsp.chmod(redlineRoot(), 0o700);
    await fsp.chmod(extDst, 0o700);
    await fsp.chmod(path.join(extDst, 'auth.js'), 0o600);
  }
  const configChanged = await writeExtensionMode(mode, dryRun);
  if (!dryRun) await fsp.chmod(configPath(), 0o600);
  return { harness: 'extension', changed: filesChanged || configChanged, paths: { extensionRoot: extDst } };
}

async function uninstallExtension(dryRun) {
  const extDst = path.join(redlineRoot(), 'extension');
  if (!(await exists(extDst))) return { harness: 'extension', changed: false, paths: {} };
  if (!dryRun) await fsp.rm(extDst, { recursive: true, force: true });
  return { harness: 'extension', changed: true, paths: { extensionRoot: extDst } };
}

function readPackageVersion(sourceRoot) {
  const p = path.join(sourceRoot, 'package.json');
  try {
    const data = JSON.parse(fs.readFileSync(p, 'utf8'));
    return data.version || null;
  } catch {
    return null;
  }
}

function checkSidecar(port) {
  return new Promise((resolve) => {
    const req = http.get({
      hostname: '127.0.0.1',
      port,
      path: '/health',
      timeout: 1000,
    }, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
    req.on('error', () => resolve(false));
  });
}

async function runStorePairingFlow({
  dataRoot = redlineDataRoot(),
  port = 7878,
  platform = process.platform,
  extensionId,
  storeListingUrl,
  extensionPresent,
  startHelper,
  createPairingWindow = () => requestPairingWindow({ dataRoot, port }),
  invalidatePairing = (secret) => requestPairingInvalidation({ dataRoot, port, secret }),
  discoverExtension = () => findInstalledExtension({ extensionId, platform }),
  portalClient,
  openUrl = (url) => openBrowser(url, { platform, portalClient }),
  stdout = process.stdout,
  stderr = process.stderr,
} = {}) {
  assertSupportedPlatform(platform);
  if (!validExtensionId(extensionId)) {
    throw new Error('Chrome Web Store identity is not configured; install a release package containing config/extension-identity.json');
  }
  if (typeof storeListingUrl !== 'string' || !/^https:\/\//.test(storeListingUrl)) {
    throw new Error('Chrome Web Store listing URL is not configured');
  }
  if (port !== 7878) throw new Error('Chrome Web Store pairing requires loopback port 7878');
  if (typeof startHelper !== 'function') throw new Error('Redline helper launcher is not configured');

  await startHelper();
  const installed = extensionPresent === undefined ? discoverExtension() : extensionPresent;
  const pairing = await createPairingWindow();
  try {
    await openUrl(`http://127.0.0.1:7878/connect#pair=${pairing.secret}&expires_at=${encodeURIComponent(pairing.expiresAt)}`);
  } catch {
    const failure = new Error('Could not open the Redline connection page. Run redline setup again.');
    try {
      await invalidatePairing(pairing.secret);
    } catch {
      failure.cause = new Error('Redline pairing cleanup failed; the pairing window will expire automatically.');
    }
    throw failure;
  }
  let openedStoreListing = false;
  if (!installed) {
    try {
      await openUrl(storeListingUrl);
      openedStoreListing = true;
    } catch {
      stderr.write('warning: Could not open the Chrome Web Store listing. Open the Redline listing, then run redline setup again if needed.\n');
    }
  }
  stdout.write('Redline helper is ready. Finish connecting in the Redline extension.\n');
  return { pairingExpiresAt: pairing.expiresAt, openedStoreListing };
}

async function requestPairingWindow({ dataRoot = redlineDataRoot(), port = 7878 } = {}) {
  let response;
  try {
    response = await requestWithCliCredential({ dataRoot, port, method: 'POST', requestPath: '/admin/pairing', timeoutMs: 1500 });
  } catch (error) {
    if (error instanceof CliCredentialError) throw new Error('Redline CLI credential is missing or unsafe; rerun redline setup');
    throw new Error('Redline helper pairing request failed');
  }
  let body;
  try { body = JSON.parse(response.body.toString('utf8')); } catch {
    throw new Error('Redline helper returned an invalid pairing response');
  }
  if (response.statusCode !== 201 || !body || !/^[A-Za-z0-9_-]{43}$/.test(body.secret || '') ||
      !Number.isFinite(Date.parse(body.expires_at))) {
    throw new Error('Redline helper refused to create a pairing window');
  }
  return { secret: body.secret, expiresAt: body.expires_at };
}

async function requestPairingInvalidation({ dataRoot = redlineDataRoot(), port = 7878, secret } = {}) {
  if (!/^[A-Za-z0-9_-]{43}$/.test(secret || '')) throw new Error('Redline pairing invalidation is invalid');
  const payload = Buffer.from(JSON.stringify({ secret }));
  let response;
  try {
    response = await requestWithCliCredential({
      dataRoot, port, method: 'DELETE', requestPath: '/admin/pairing', body: payload, timeoutMs: 1500,
    });
  } catch (error) {
    if (error instanceof CliCredentialError) throw new Error('Redline CLI credential is missing or unsafe; rerun redline setup');
    throw new Error('Redline helper pairing invalidation failed');
  }
  if (response.statusCode !== 204) throw new Error('Redline helper refused to invalidate the pairing window');
}

function loadStoreIdentity(sourceRoot) {
  const configured = process.env.REDLINE_TEST_MODE === '1' && process.env.REDLINE_IDENTITY_PATH
    ? process.env.REDLINE_IDENTITY_PATH
    : path.join(sourceRoot, 'config', 'extension-identity.json');
  return loadExtensionIdentity(configured);
}

async function startInstalledHelper(sourceRoot) {
  const launcher = path.join(sourceRoot, 'runtime', 'bin', 'redline-sidecar');
  const result = spawnSync(launcher, ['start'], { encoding: 'utf8', env: process.env });
  if (result.error || result.status !== 0) {
    throw new Error('Redline helper could not start; run redline-sidecar status for details');
  }
  if (!await checkSidecar(7878)) throw new Error('Redline helper did not become ready on 127.0.0.1:7878');
}

function pairedBrowserCount() {
  try {
    const file = path.join(redlineDataRoot(), 'state.json');
    if (!fs.existsSync(file)) return null;
    const state = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!state || typeof state !== 'object' || !state.clients || typeof state.clients !== 'object' ||
        Array.isArray(state.clients)) {
      return null;
    }
    return Object.keys(state.clients).length;
  } catch {
    return null;
  }
}

async function storeExtensionStatus(sourceRoot) {
  const { extensionId, storeListingUrl } = loadStoreIdentity(sourceRoot);
  const mockedPresence = process.env.REDLINE_TEST_MODE === '1' && process.env.REDLINE_EXTENSION_PRESENT !== undefined;
  const inspection = mockedPresence
    ? null
    : inspectInstalledExtension({ extensionId, platform: process.platform });
  const extensionPresent = mockedPresence
    ? process.env.REDLINE_EXTENSION_PRESENT === '1'
    : inspection.status === 'enabled';
  const helperStatus = process.env.REDLINE_TEST_MODE === '1' && process.env.REDLINE_TEST_HELPER_UP !== undefined
    ? (process.env.REDLINE_TEST_HELPER_UP === '1' ? { kind: 'compatible' } : { kind: 'refused' })
    : await healthProbe(7878);

  log(color('bold', 'Chrome Web Store extension status'));
  let ok = true;
  if (extensionPresent) {
    const detail = inspection?.version
      ? `${inspection.version} installed and enabled in ${inspection.profile}`
      : 'installed and enabled in the active Chrome profile';
    log(`  ${color('green', 'extension:')} ${detail}`);
  } else if (inspection?.status === 'disabled') {
    ok = false;
    log(`  ${color('red', 'extension:')} installed but disabled in ${inspection.profile}`);
    log('  Enable Redline in chrome://extensions');
  } else {
    ok = false;
    log(`  ${color('red', 'Chrome Web Store extension: missing')}`);
    log('  Install: ' + color('bold', storeListingUrl));
  }

  if (helperStatus.kind === 'compatible') {
    const helperVersion = helperStatus.packageVersion ? `${helperStatus.packageVersion} ` : '';
    log(`  ${color('green', 'helper:')} ${helperVersion}up at http://127.0.0.1:7878`);
  } else if (helperStatus.kind === 'incompatible') {
    ok = false;
    log(`  ${color('red', 'helper:')} incompatible at http://127.0.0.1:7878`);
    log('  Run: ' + color('bold', 'redline restart'));
  } else {
    ok = false;
    log(`  ${color('red', 'helper:')} down at http://127.0.0.1:7878`);
    log('  Run: ' + color('bold', 'redline setup'));
  }

  const pairedCount = pairedBrowserCount();
  if (pairedCount === 0) {
    ok = false;
    log(`  ${color('red', 'pairing:')} no browser connected`);
    log('  Run: ' + color('bold', 'redline setup'));
  } else if (pairedCount > 0) {
    log(`  ${color('green', 'pairing:')} ${pairedCount} browser${pairedCount === 1 ? '' : 's'} recorded`);
    log(`  ${color('cyan', 'popup:')} confirm this Chrome profile says Connected`);
  } else {
    log(`  ${color('cyan', 'popup:')} verify that this Chrome profile is paired`);
  }
  return ok;
}

async function unpackedExtensionStatus(sourceRoot) {
  const extDst = path.join(redlineRoot(), 'extension');
  const manifestPath = path.join(extDst, 'manifest.json');
  const packageVersion = readPackageVersion(sourceRoot);
  const port = parseInt(process.env.REDLINE_PORT || '7878', 10);

  log(color('bold', 'Chrome extension status'));
  log(color('dim', `path: ${extDst}`));

  let ok = true;
  if (!(await exists(manifestPath))) {
    ok = false;
    log(`  ${color('red', 'missing:')} ${manifestPath}`);
    log('  Run: ' + color('bold', 'redline setup --with-screenshots'));
  } else {
    let manifest = null;
    try {
      manifest = JSON.parse(await fsp.readFile(manifestPath, 'utf8'));
    } catch (e) {
      ok = false;
      log(`  ${color('red', 'invalid manifest:')} ${e.message}`);
    }

    if (manifest) {
      const installedVersion = manifest.version || '(missing)';
      const mode = detectScreenshotMode(manifest);
      const authToken = await readAuthToken();
      const port = redlinePort();
      const extSrc = path.join(sourceRoot, 'extension');
      const devManifest = await fsp.readFile(path.join(extSrc, 'manifest.dev.json'), 'utf8');
      const { publicKey } = loadStoreIdentity(sourceRoot);
      const filesOutOfSync = !authToken || (await exists(extSrc)
          ? await copyTree(extSrc, extDst, true, {
            'manifest.json': () => patchExtensionManifestForMode(devManifest, mode, publicKey),
            'auth.js': (raw) => patchExtensionAuth(raw, authToken, port),
            'background.js': patchExtensionBackground,
          }, { 'auth.js': 0o600 }, new Set(['manifest.dev.json']))
        : false);
      log(`  installed: ${installedVersion}`);
      log(`  package: ${packageVersion || '(unknown)'}`);
      log(`  mode: ${extensionModeLabel(mode)}`);
      if (mode === 'full') {
        log(`  ${color('green', 'screenshots:')} enabled for http/https pages`);
      } else {
        log(`  ${color('yellow', 'screenshots:')} limited; enable full visual redlines with ${color('bold', 'redline setup --with-screenshots')}`);
      }
      if ((packageVersion && installedVersion !== packageVersion) || filesOutOfSync) {
        ok = false;
        log(`  ${color('yellow', 'out of sync:')} run ${color('bold', 'redline setup')}, then reload Redline in Chrome`);
      } else {
        log(`  ${color('green', 'synced:')} extension files match this package version`);
      }
    }
  }

  const sidecarUp = await checkSidecar(port);
  if (sidecarUp) {
    log(`  ${color('green', 'sidecar:')} up at http://127.0.0.1:${port}`);
  } else {
    ok = false;
    log(`  ${color('yellow', 'sidecar:')} down at http://127.0.0.1:${port}`);
    log('  Start it with: ' + color('bold', 'redline start'));
  }

  log('');
  log(color('cyan', 'Chrome checklist:'));
  log('  1. Open ' + color('bold', 'chrome://extensions'));
  log('  2. Enable ' + color('bold', 'Developer mode'));
  log('  3. Make sure Redline points at ' + color('bold', extDst));
  log('  4. Click ' + color('bold', 'Reload') + ' after running setup or pulling updates');
  log('  5. Then reload the page tabs you already had open so their content scripts update');
  log('  6. If Redline is disabled, toggle it back on');

  return ok;
}

async function extensionStatus(sourceRoot) {
  const storeMode = redlinePort() === 7878 && process.env.REDLINE_DEV_MODE !== '1';
  return storeMode ? storeExtensionStatus(sourceRoot) : unpackedExtensionStatus(sourceRoot);
}

async function main() {
  const opts = parseArgs(process.argv);
  if (opts.help) {
    printHelp();
    return;
  }

  const sourceRoot = opts.source ? path.resolve(opts.source) : resolvePackageRoot();

  if (redlinePort() !== 7878 && process.env.REDLINE_DEV_MODE !== '1') {
    throw new Error('non-7878 REDLINE_PORT values require explicit REDLINE_DEV_MODE=1');
  }
  if (redlinePort() === 7878 && process.env.REDLINE_DEV_MODE === '1') {
    throw new Error('explicit dev mode requires a non-7878 REDLINE_PORT');
  }
  if (process.env.REDLINE_DEV_MODE === '1' && !validExtensionId(process.env.REDLINE_EXTENSION_ID)) {
    throw new Error('explicit dev mode requires a valid injected REDLINE_EXTENSION_ID');
  }

  if (opts.extensionStatus) {
    const ok = await extensionStatus(sourceRoot);
    process.exitCode = ok ? 0 : 1;
    return;
  }

  const storeSetup = !opts.uninstall && !opts.dryRun && redlinePort() === 7878 && process.env.REDLINE_DEV_MODE !== '1';
  if (storeSetup) {
    const identity = loadStoreIdentity(sourceRoot);
    await runStorePairingFlow({
      ...identity,
      dataRoot: redlineDataRoot(),
      startHelper: () => startInstalledHelper(sourceRoot),
      extensionPresent: process.env.REDLINE_TEST_MODE === '1' && process.env.REDLINE_EXTENSION_PRESENT !== undefined
        ? process.env.REDLINE_EXTENSION_PRESENT === '1'
        : undefined,
    });
    return;
  }

  if (!opts.uninstall) {
    const extensionSource = path.join(sourceRoot, 'extension');
    if (!(await exists(extensionSource))) {
      fail(`Chrome extension source missing at ${extensionSource}`);
    }
  }

  const extensionMode = opts.uninstall ? null : await resolveExtensionMode(opts);
  if (!opts.dryRun && !opts.uninstall) {
    const missing = missingRequiredCommands(['bash', 'curl', 'jq']);
    if (missing.length) {
      fail(`missing required commands: ${missing.join(', ')}. Redline requires Bash, curl, and jq for runtime use.`);
    }
  }

  log(color('bold', `Redline extension ${opts.uninstall ? 'uninstall' : 'setup'}${opts.dryRun ? ' (dry run)' : ''}`));
  log(color('dim', `source: ${sourceRoot}`));
  if (!opts.uninstall) {
    log(color('dim', `extension mode: ${extensionModeLabel(extensionMode)}`));
  }
  log('');

  try {
    const result = opts.uninstall
      ? await uninstallExtension(opts.dryRun)
      : await syncExtension(sourceRoot, opts.dryRun, extensionMode);
    if (result.changed) {
      log(`  ${color('green', 'extension:')} ${opts.uninstall ? 'removed' : 'synced'}`);
      for (const [key, value] of Object.entries(result.paths)) {
        log(color('dim', `    ${key}: ${value}`));
      }
    } else {
      log(`  ${color('dim', 'extension:')} ${color('dim', opts.uninstall ? 'nothing to remove' : 'already up to date')}`);
    }
  } catch (error) {
    warn(`extension: ${error.message}`);
    process.exitCode = 1;
    return;
  }

  if (!opts.uninstall) {
    log('');
    log(color('cyan', 'Next:'));
    log('  1. Start the sidecar:    ' + color('bold', 'redline start'));
    log('  2. Chrome → ' + color('bold', 'chrome://extensions') + ' → Load unpacked → pick ' + color('bold', path.join(redlineRoot(), 'extension')));
    log('  3. If Redline was already loaded, click ' + color('bold', 'Reload') + ' on its extension card.');
    log('  4. Then reload the page tabs you already had open so their content scripts update.');
    log('');
    if (extensionMode === 'full') {
      log('  ' + color('green', 'screenshots: enabled') + ' — Redline works on any http/https page and captures page screenshots.');
      log('  Chrome may show broader site-access wording because you chose the full visual redline mode.');
    } else {
      log('  ' + color('yellow', 'screenshots: limited') + ' — Redline is installed with low page-access permissions.');
      log('  For full visual redlines on normal websites, run: ' + color('bold', 'redline setup --with-screenshots'));
    }
    log('');
    log('Agent skills are unchanged. Manage the Redline skill directly with:');
    log('  ' + color('bold', 'npx skills add ArchAstro/redline'));
    log('');
    log('Check the extension later with: ' + color('bold', 'redline status'));
  }
}

if (require.main === module) {
  main().catch((error) => fail(error.message));
}

module.exports = {
  loadStoreIdentity,
  patchExtensionManifestForMode,
  requestPairingInvalidation,
  requestPairingWindow,
  runStorePairingFlow,
};
