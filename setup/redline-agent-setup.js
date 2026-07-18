#!/usr/bin/env node
// Install / update / uninstall the Redline plugin into local Claude Code
// and / or Codex. Designed to be run via:
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

const MARKETPLACE = 'redline';
const PLUGIN = 'redline';
const PLUGIN_KEY = `${PLUGIN}@${MARKETPLACE}`;
const FULL_ACCESS_PATTERN = '<all_urls>';

const HARNESSES = ['claude', 'codex'];

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
    claudeOnly: false,
    codexOnly: false,
    uninstall: false,
    dryRun: false,
    pluginSource: null,
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
      case '--claude-only': opts.claudeOnly = true; break;
      case '--codex-only': opts.codexOnly = true; break;
      case '--uninstall': case '--remove': opts.uninstall = true; break;
      case '--dry-run': opts.dryRun = true; break;
      case '--extension-status': opts.extensionStatus = true; break;
      case '--with-screenshots': opts.withScreenshots = true; break;
      case '--local-only': opts.localOnly = true; break;
      case '--plugin-source': opts.pluginSource = args[++i]; break;
      case '-h': case '--help': opts.help = true; break;
      default:
        if (a.startsWith('--plugin-source=')) {
          opts.pluginSource = a.slice('--plugin-source='.length);
        } else {
          fail(`unknown arg: ${a} (try --help)`);
        }
    }
  }
  if (opts.claudeOnly && opts.codexOnly) {
    fail('pass at most one of --claude-only and --codex-only');
  }
  if (opts.withScreenshots && opts.localOnly) {
    fail('pass at most one of --with-screenshots and --local-only');
  }
  return opts;
}

function printHelp() {
  log(`redline-agent-setup — install Redline into Claude Code and/or Codex

Usage:
  redline-agent-setup                # install for any harness present
  redline-agent-setup --claude-only  # only install the Claude plugin
  redline-agent-setup --codex-only   # only install the Codex plugin
  redline-agent-setup --uninstall    # remove the plugin from both harnesses
  redline-agent-setup --dry-run      # print what would change without writing
  redline-agent-setup --with-screenshots
                                   # enable full page access for screenshots
  redline-agent-setup --local-only   # switch back to the low-permission mode
  redline-agent-setup --extension-status
                                   # check Chrome extension sync + sidecar

Options:
  --plugin-source PATH   Override the source dir (defaults to this npm package).
  -h, --help             Show this help.
`);
}

function resolvePackageRoot() {
  // setup/redline-agent-setup.js lives at <pkg>/setup/, so the package root
  // is one level up.
  return path.resolve(__dirname, '..');
}

function resolvePluginRoot(harness, sourceRoot) {
  if (harness === 'claude') return path.join(sourceRoot, '.claude-plugins', PLUGIN);
  if (harness === 'codex') return path.join(sourceRoot, 'plugins', PLUGIN);
  throw new Error(`unknown harness: ${harness}`);
}

function manifestPath(harness, pluginRoot) {
  const sub = harness === 'claude' ? '.claude-plugin/plugin.json' : '.codex-plugin/plugin.json';
  return path.join(pluginRoot, sub);
}

async function readVersion(harness, pluginRoot) {
  const p = manifestPath(harness, pluginRoot);
  const raw = await fsp.readFile(p, 'utf8');
  const data = JSON.parse(raw);
  if (typeof data.version !== 'string' || !data.version) {
    throw new Error(`${p} is missing a version`);
  }
  return data.version;
}

async function exists(p) {
  try { await fsp.access(p); return true; } catch { return false; }
}

async function readJsonOrNull(p) {
  if (!(await exists(p))) return null;
  try { return JSON.parse(await fsp.readFile(p, 'utf8')); } catch { return null; }
}

async function writeFileIfChanged(p, content, dryRun) {
  const existing = (await exists(p)) ? await fsp.readFile(p, 'utf8') : null;
  if (existing === content) return false;
  if (!dryRun) {
    await fsp.mkdir(path.dirname(p), { recursive: true });
    await fsp.writeFile(p, content);
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

async function copyTree(src, dst, dryRun, transforms = {}) {
  let changed = false;
  const wanted = new Set();
  const files = await walk(src);
  for (const file of files) {
    const rel = path.relative(src, file);
    wanted.add(rel);
    const target = path.join(dst, rel);
    let srcBuf = await fsp.readFile(file);
    if (transforms[rel]) {
      srcBuf = Buffer.from(transforms[rel](srcBuf.toString('utf8')), 'utf8');
    }
    const sourceMode = (await fsp.stat(file)).mode & 0o777;
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

async function pruneOtherVersions(versionedRoot, keep, dryRun) {
  if (!(await exists(versionedRoot))) return false;
  let changed = false;
  for (const e of await fsp.readdir(versionedRoot, { withFileTypes: true })) {
    if (!e.isDirectory() || e.name === keep) continue;
    changed = true;
    if (!dryRun) await fsp.rm(path.join(versionedRoot, e.name), { recursive: true, force: true });
  }
  return changed;
}

// ---------- Claude ----------

async function installClaude(sourceRoot, dryRun) {
  const pluginRoot = resolvePluginRoot('claude', sourceRoot);
  if (!(await exists(pluginRoot))) throw new Error(`Claude plugin source missing at ${pluginRoot}`);
  const marketplaceManifestSrc = path.join(sourceRoot, '.claude-plugin', 'marketplace.json');
  if (!(await exists(marketplaceManifestSrc))) throw new Error(`marketplace.json missing at ${marketplaceManifestSrc}`);
  const version = await readVersion('claude', pluginRoot);
  const home = os.homedir();
  const versionedRoot = path.join(home, '.claude', 'plugins', 'cache', MARKETPLACE, PLUGIN);
  const installRoot = path.join(versionedRoot, version);
  const registryPath = path.join(home, '.claude', 'plugins', 'installed_plugins.json');
  const settingsPath = path.join(home, '.claude', 'settings.json');
  const marketplaceRoot = path.join(home, '.claude', 'plugins', 'marketplaces', MARKETPLACE);
  const marketplaceManifestDest = path.join(marketplaceRoot, '.claude-plugin', 'marketplace.json');
  const marketplacePluginDest = path.join(marketplaceRoot, '.claude-plugins', PLUGIN);
  const knownMarketplacesPath = path.join(home, '.claude', 'plugins', 'known_marketplaces.json');

  const pruned = await pruneOtherVersions(versionedRoot, version, dryRun);
  const filesChanged = await copyTree(pluginRoot, installRoot, dryRun);

  // Materialize the marketplace under ~/.claude/plugins/marketplaces/<MARKETPLACE>/
  // so Claude can resolve `redline@redline` — without this the plugin shows up as
  // installed but errors with `Plugin "redline" not found in marketplace "redline"`.
  const manifestBuf = await fsp.readFile(marketplaceManifestSrc);
  const manifestChanged = await writeFileIfChanged(marketplaceManifestDest, manifestBuf.toString('utf8'), dryRun);
  const marketplacePluginChanged = await copyTree(pluginRoot, marketplacePluginDest, dryRun);

  // known_marketplaces.json — register as a local marketplace pointing at the dir above.
  const known = (await readJsonOrNull(knownMarketplacesPath)) || {};
  const now = new Date().toISOString();
  const prevEntry = known[MARKETPLACE];
  // Claude's schema renamed local-filesystem marketplaces from `local` → `directory`
  // (Claude Code >= 2.1.x). Older installs of this setup wrote `source: 'local'`,
  // which is now rejected and corrupts /plugin entirely. We always write the
  // current `directory` form so re-running the setup heals a broken state.
  const prevSame = prevEntry
    && prevEntry.source && prevEntry.source.source === 'directory' && prevEntry.source.path === marketplaceRoot
    && prevEntry.installLocation === marketplaceRoot;
  const nextKnown = {
    ...known,
    [MARKETPLACE]: {
      source: { source: 'directory', path: marketplaceRoot },
      installLocation: marketplaceRoot,
      lastUpdated: prevSame ? prevEntry.lastUpdated : now,
    },
  };
  const knownChanged = await writeFileIfChanged(knownMarketplacesPath, JSON.stringify(nextKnown, null, 2) + '\n', dryRun);

  // settings.json — set enabledPlugins["redline@redline"] = true
  const settings = (await readJsonOrNull(settingsPath)) || {};
  const enabledPlugins = (settings.enabledPlugins && typeof settings.enabledPlugins === 'object' && !Array.isArray(settings.enabledPlugins))
    ? { ...settings.enabledPlugins } : {};
  enabledPlugins[PLUGIN_KEY] = true;
  const nextSettings = { ...settings, enabledPlugins };
  const settingsChanged = await writeFileIfChanged(settingsPath, JSON.stringify(nextSettings, null, 2) + '\n', dryRun);

  // installed_plugins.json — append or upsert the user-scope entry
  const registry = (await readJsonOrNull(registryPath)) || {};
  const plugins = (registry.plugins && typeof registry.plugins === 'object' && !Array.isArray(registry.plugins))
    ? { ...registry.plugins } : {};
  const entries = Array.isArray(plugins[PLUGIN_KEY]) ? [...plugins[PLUGIN_KEY]] : [];
  const idx = entries.findIndex((e) => e && e.scope === 'user' && !e.projectPath);
  const prevInstalledAt = idx >= 0 && typeof entries[idx].installedAt === 'string' ? entries[idx].installedAt : now;
  const next = { scope: 'user', installPath: installRoot, version, installedAt: prevInstalledAt, lastUpdated: now };
  if (idx >= 0) entries[idx] = next; else entries.push(next);
  const nextRegistry = {
    ...registry,
    version: typeof registry.version === 'number' ? registry.version : 2,
    plugins: { ...plugins, [PLUGIN_KEY]: entries },
  };
  const registryChanged = await writeFileIfChanged(registryPath, JSON.stringify(nextRegistry, null, 2) + '\n', dryRun);

  return {
    harness: 'claude',
    version,
    changed: pruned || filesChanged || manifestChanged || marketplacePluginChanged || knownChanged || settingsChanged || registryChanged,
    paths: { installRoot, marketplaceRoot, knownMarketplacesPath, settingsPath, registryPath },
  };
}

async function uninstallClaude(dryRun) {
  const home = os.homedir();
  const cacheRoot = path.join(home, '.claude', 'plugins', 'cache', MARKETPLACE);
  const marketplaceRoot = path.join(home, '.claude', 'plugins', 'marketplaces', MARKETPLACE);
  const knownMarketplacesPath = path.join(home, '.claude', 'plugins', 'known_marketplaces.json');
  const registryPath = path.join(home, '.claude', 'plugins', 'installed_plugins.json');
  const settingsPath = path.join(home, '.claude', 'settings.json');
  let changed = false;

  if (await exists(cacheRoot)) {
    changed = true;
    if (!dryRun) await fsp.rm(cacheRoot, { recursive: true, force: true });
  }
  if (await exists(marketplaceRoot)) {
    changed = true;
    if (!dryRun) await fsp.rm(marketplaceRoot, { recursive: true, force: true });
  }

  const known = await readJsonOrNull(knownMarketplacesPath);
  if (known && MARKETPLACE in known) {
    const { [MARKETPLACE]: _, ...rest } = known;
    changed = (await writeFileIfChanged(knownMarketplacesPath, JSON.stringify(rest, null, 2) + '\n', dryRun)) || changed;
  }

  const settings = await readJsonOrNull(settingsPath);
  if (settings && settings.enabledPlugins && PLUGIN_KEY in settings.enabledPlugins) {
    const { [PLUGIN_KEY]: _, ...rest } = settings.enabledPlugins;
    const nextSettings = { ...settings, enabledPlugins: rest };
    changed = (await writeFileIfChanged(settingsPath, JSON.stringify(nextSettings, null, 2) + '\n', dryRun)) || changed;
  }

  const registry = await readJsonOrNull(registryPath);
  if (registry && registry.plugins && PLUGIN_KEY in registry.plugins) {
    const { [PLUGIN_KEY]: _, ...rest } = registry.plugins;
    const nextRegistry = { ...registry, plugins: rest };
    changed = (await writeFileIfChanged(registryPath, JSON.stringify(nextRegistry, null, 2) + '\n', dryRun)) || changed;
  }

  return { harness: 'claude', changed, paths: { cacheRoot, marketplaceRoot, knownMarketplacesPath, settingsPath, registryPath } };
}

// ---------- Codex ----------

function upsertTomlSection(content, section, values) {
  const header = `[${section}]`;
  const lines = content ? content.split(/\r?\n/) : [];
  const start = lines.findIndex((l) => l.trim() === header);
  if (start === -1) {
    const prefix = lines.length > 0 && lines[lines.length - 1] !== '' ? [''] : [];
    return [
      ...lines,
      ...prefix,
      header,
      ...Object.entries(values).map(([k, v]) => `${k} = ${v}`),
      '',
    ].join('\n');
  }
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^\s*\[.*\]\s*$/.test(lines[i])) { end = i; break; }
  }
  const sectionLines = lines.slice(start + 1, end);
  for (const [k, v] of Object.entries(values)) {
    const re = new RegExp(`^\\s*${k.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\$&')}\\s*=`);
    const idx = sectionLines.findIndex((l) => re.test(l));
    if (idx >= 0) sectionLines[idx] = `${k} = ${v}`;
    else sectionLines.push(`${k} = ${v}`);
  }
  return [...lines.slice(0, start + 1), ...sectionLines, ...lines.slice(end)].join('\n');
}

function removeTomlSection(content, section) {
  const header = `[${section}]`;
  const lines = content.split(/\r?\n/);
  const start = lines.findIndex((l) => l.trim() === header);
  if (start === -1) return { content, changed: false };
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^\s*\[.*\]\s*$/.test(lines[i])) { end = i; break; }
  }
  while (end < lines.length && lines[end] === '') end++;
  const next = [...lines.slice(0, start), ...lines.slice(end)].join('\n');
  return { content: next, changed: true };
}

function tomlString(v) { return JSON.stringify(v); }

async function installCodex(sourceRoot, dryRun) {
  const pluginRoot = resolvePluginRoot('codex', sourceRoot);
  if (!(await exists(pluginRoot))) throw new Error(`Codex plugin source missing at ${pluginRoot}`);
  const canonicalServerPath = path.join(resolvePluginRoot('claude', sourceRoot), 'server.js');
  if (!(await exists(canonicalServerPath))) throw new Error(`Canonical server source missing at ${canonicalServerPath}`);
  const canonicalServer = await fsp.readFile(canonicalServerPath, 'utf8');
  const installTransforms = { 'server.js': () => canonicalServer };
  const version = await readVersion('codex', pluginRoot);
  const home = os.homedir();
  const codexRoot = path.join(home, '.codex');
  const configPath = path.join(codexRoot, 'config.toml');
  const versionedRoot = path.join(codexRoot, 'plugins', 'cache', MARKETPLACE, PLUGIN);
  const cacheRoot = path.join(versionedRoot, version);
  const marketplaceRoot = path.join(home, '.agents', 'plugins');
  const marketplacePluginRoot = path.join(marketplaceRoot, 'plugins', PLUGIN);
  const marketplacePath = path.join(marketplaceRoot, 'marketplace.json');

  const marketplace = {
    name: MARKETPLACE,
    interface: { displayName: 'Redline' },
    plugins: [
      {
        name: PLUGIN,
        source: { source: 'local', path: `./plugins/${PLUGIN}` },
        policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' },
        category: 'Development',
      },
    ],
  };

  const pruned = await pruneOtherVersions(versionedRoot, version, dryRun);
  const cacheChanged = await copyTree(pluginRoot, cacheRoot, dryRun, installTransforms);
  const marketplaceFilesChanged = await copyTree(pluginRoot, marketplacePluginRoot, dryRun, installTransforms);
  const marketplaceChanged = await writeFileIfChanged(marketplacePath, JSON.stringify(marketplace, null, 2) + '\n', dryRun);

  let configContent = (await exists(configPath)) ? await fsp.readFile(configPath, 'utf8') : '';
  let next = upsertTomlSection(configContent, `plugins."${PLUGIN_KEY}"`, { enabled: 'true' });
  next = upsertTomlSection(next, `marketplaces.${MARKETPLACE}`, {
    source_type: tomlString('local'),
    source: tomlString(marketplaceRoot),
  });
  if (!next.endsWith('\n')) next += '\n';
  const configChanged = await writeFileIfChanged(configPath, next, dryRun);

  return {
    harness: 'codex',
    version,
    changed: pruned || cacheChanged || marketplaceFilesChanged || marketplaceChanged || configChanged,
    paths: { cacheRoot, marketplacePath, configPath },
  };
}

async function uninstallCodex(dryRun) {
  const home = os.homedir();
  const codexRoot = path.join(home, '.codex');
  const cacheRoot = path.join(codexRoot, 'plugins', 'cache', MARKETPLACE);
  const marketplaceRoot = path.join(home, '.agents', 'plugins');
  const marketplacePluginRoot = path.join(marketplaceRoot, 'plugins', PLUGIN);
  const configPath = path.join(codexRoot, 'config.toml');
  let changed = false;

  if (await exists(cacheRoot)) {
    changed = true;
    if (!dryRun) await fsp.rm(cacheRoot, { recursive: true, force: true });
  }
  if (await exists(marketplacePluginRoot)) {
    changed = true;
    if (!dryRun) await fsp.rm(marketplacePluginRoot, { recursive: true, force: true });
  }
  if (await exists(configPath)) {
    let config = await fsp.readFile(configPath, 'utf8');
    let before = config;
    config = removeTomlSection(config, `plugins."${PLUGIN_KEY}"`).content;
    config = removeTomlSection(config, `marketplaces.${MARKETPLACE}`).content;
    if (config !== before) {
      changed = true;
      if (!dryRun) await fsp.writeFile(configPath, config.endsWith('\n') ? config : config + '\n');
    }
  }

  return { harness: 'codex', changed, paths: { cacheRoot, marketplacePluginRoot, configPath } };
}

// ---------- Main ----------

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
    if (!dryRun) await fsp.chmod(authTokenPath(), 0o600);
    return existing;
  }
  const token = crypto.randomBytes(32).toString('base64url');
  if (!dryRun) {
    await fsp.mkdir(redlineDataRoot(), { recursive: true });
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

function patchExtensionManifestForMode(raw, mode) {
  const manifest = JSON.parse(raw);
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
  if (!(await exists(extSrc))) return { harness: 'extension', changed: false, paths: {} };
  const authToken = await ensureAuthToken(dryRun);
  const port = redlinePort();
  const filesChanged = await copyTree(extSrc, extDst, dryRun, {
    'manifest.json': (raw) => patchExtensionManifestForMode(raw, mode),
    'auth.js': (raw) => patchExtensionAuth(raw, authToken, port),
  });
  const configChanged = await writeExtensionMode(mode, dryRun);
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

async function extensionStatus(sourceRoot) {
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
      const filesOutOfSync = !authToken || (await exists(extSrc)
        ? await copyTree(extSrc, extDst, true, {
            'manifest.json': (raw) => patchExtensionManifestForMode(raw, mode),
            'auth.js': (raw) => patchExtensionAuth(raw, authToken, port),
          })
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

async function main() {
  const opts = parseArgs(process.argv);
  if (opts.help) { printHelp(); return; }

  const targets = opts.claudeOnly ? ['claude'] : opts.codexOnly ? ['codex'] : HARNESSES;
  const sourceRoot = opts.pluginSource ? path.resolve(opts.pluginSource) : resolvePackageRoot();
  const extensionMode = await resolveExtensionMode(opts);

  if (opts.extensionStatus) {
    const ok = await extensionStatus(sourceRoot);
    process.exitCode = ok ? 0 : 1;
    return;
  }

  log(color('bold', `Redline ${opts.uninstall ? 'uninstall' : 'install'}${opts.dryRun ? ' (dry run)' : ''}`));
  log(color('dim', `source: ${sourceRoot}`));
  if (!opts.uninstall) {
    log(color('dim', `extension mode: ${extensionModeLabel(extensionMode)}`));
  }
  log('');

  for (const h of targets) {
    try {
      const r = opts.uninstall
        ? (h === 'claude' ? await uninstallClaude(opts.dryRun) : await uninstallCodex(opts.dryRun))
        : (h === 'claude' ? await installClaude(sourceRoot, opts.dryRun) : await installCodex(sourceRoot, opts.dryRun));
      const label = `${h}:`;
      if (!r.changed) {
        log(`  ${color('dim', label)} ${color('dim', opts.uninstall ? 'nothing to remove' : 'already up to date')}`);
      } else {
        log(`  ${color('green', label)} ${opts.uninstall ? 'removed' : `installed v${r.version}`}`);
        for (const [k, v] of Object.entries(r.paths)) {
          log(color('dim', `    ${k}: ${v}`));
        }
      }
    } catch (e) {
      warn(`${h}: ${e.message}`);
    }
  }

  try {
    const r = opts.uninstall ? await uninstallExtension(opts.dryRun) : await syncExtension(sourceRoot, opts.dryRun, extensionMode);
    if (r.changed) {
      log(`  ${color('green', 'extension:')} ${opts.uninstall ? 'removed' : 'synced'}`);
      for (const [k, v] of Object.entries(r.paths)) {
        log(color('dim', `    ${k}: ${v}`));
      }
    } else {
      log(`  ${color('dim', 'extension:')} ${color('dim', opts.uninstall ? 'nothing to remove' : 'already up to date')}`);
    }
  } catch (e) {
    warn(`extension: ${e.message}`);
  }

  log('');
  if (!opts.uninstall) {
    log(color('cyan', 'Next:'));
    log('  1. Reload your Claude / Codex session.');
    log('  2. Start the sidecar:    ' + color('bold', 'redline start'));
    log('  3. Chrome → ' + color('bold', 'chrome://extensions') + ' → Load unpacked → pick ' + color('bold', path.join(redlineRoot(), 'extension')));
    log('  4. If Redline was already loaded, click ' + color('bold', 'Reload') + ' on its extension card.');
    log('  5. Then reload the page tabs you already had open so their content scripts update.');
    log('');
    if (extensionMode === 'full') {
      log('  ' + color('green', 'screenshots: enabled') + ' — Redline works on any http/https page and captures page screenshots.');
      log('  Chrome may show broader site-access wording because you chose the full visual redline mode.');
    } else {
      log('  ' + color('yellow', 'screenshots: limited') + ' — Redline is installed with low page-access permissions.');
      log('  For full visual redlines on normal websites, run: ' + color('bold', 'redline setup --with-screenshots'));
    }
    log('');
    log('Check later with: ' + color('bold', 'redline status'));
  }
}

main().catch((e) => fail(e.stack || e.message));
