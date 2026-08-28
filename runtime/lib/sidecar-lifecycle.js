'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { parseHealthResponse, parseInstanceId, parseLaunchId, parsePort } = require('./protocol');

const SERVER = path.resolve(__dirname, '../server.js');
const SLEEP_BUFFER = new Int32Array(new SharedArrayBuffer(4));

function sleepSync(milliseconds) {
  Atomics.wait(SLEEP_BUFFER, 0, 0, milliseconds);
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function pathsFor(env = process.env) {
  const dir = path.resolve(env.REDLINE_DIR || path.join(env.HOME || os.homedir(), '.redline'));
  return {
    dir,
    pidFile: path.join(dir, 'sidecar.pid'),
    logFile: path.join(dir, 'sidecar.log'),
    lockDir: path.join(dir, 'sidecar.start.lock'),
    identityFile: path.join(dir, 'instance-id'),
    identityMarker: path.join(dir, 'instance-id.initialized'),
  };
}

function ensureDataDir(dir, { create }) {
  let before;
  try {
    before = fs.lstatSync(dir);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    if (!create) return false;
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    before = fs.lstatSync(dir);
  }
  if (!before.isDirectory() || before.isSymbolicLink()) {
    throw new Error('REDLINE_DIR must be a real directory, not a symlink');
  }
  const fd = fs.openSync(dir, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    const opened = fs.fstatSync(fd);
    if (!opened.isDirectory() || opened.dev !== before.dev || opened.ino !== before.ino) {
      throw new Error('REDLINE_DIR changed while it was being opened');
    }
    fs.fchmodSync(fd, 0o700);
  } finally {
    fs.closeSync(fd);
  }
  return true;
}

function directoryIdentity(dir) {
  const before = fs.lstatSync(dir, { bigint: true });
  if (!before.isDirectory() || before.isSymbolicLink()) {
    throw new Error('REDLINE_DIR must be a real directory, not a symlink');
  }
  const fd = fs.openSync(dir, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    const opened = fs.fstatSync(fd, { bigint: true });
    if (!opened.isDirectory() || opened.dev !== before.dev || opened.ino !== before.ino) {
      throw new Error('REDLINE_DIR changed while its identity was being read');
    }
    return { device: String(opened.dev), inode: String(opened.ino) };
  } finally {
    fs.closeSync(fd);
  }
}

function inspectLifecycleFile(file, label, { read = true } = {}) {
  let before;
  try {
    before = fs.lstatSync(file);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  if (!before.isFile() || before.isSymbolicLink()) {
    throw new Error(`${label} is not a regular file; symlinks are refused`);
  }
  if (before.nlink !== 1) {
    throw new Error(`${label} has multiple links; refusing hard-linked lifecycle state`);
  }
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    const opened = fs.fstatSync(fd);
    if (!opened.isFile() || opened.nlink !== 1 || opened.dev !== before.dev || opened.ino !== before.ino) {
      throw new Error(`${label} changed while it was being opened`);
    }
    const rawContents = read ? fs.readFileSync(fd, 'utf8') : null;
    return { before, contents: read ? rawContents.trim() : null, rawContents };
  } finally {
    fs.closeSync(fd);
  }
}

function removeLifecycleFile(file, label, expected) {
  const inspected = inspectLifecycleFile(file, label);
  if (!inspected) return false;
  if (expected !== undefined && inspected.contents !== String(expected)) {
    throw new Error(`${label} ownership changed`);
  }
  const current = fs.lstatSync(file);
  if (!current.isFile() || current.isSymbolicLink() || current.nlink !== 1 ||
      current.dev !== inspected.before.dev || current.ino !== inspected.before.ino) {
    throw new Error(`${label} changed before removal`);
  }
  fs.unlinkSync(file);
  return true;
}

function readPrivateIdentity(file, label) {
  const inspected = inspectLifecycleFile(file, label);
  if (!inspected) return null;
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    const opened = fs.fstatSync(fd);
    if (opened.nlink !== 1 || opened.dev !== inspected.before.dev || opened.ino !== inspected.before.ino) {
      throw new Error(`${label} changed before permission repair`);
    }
    fs.fchmodSync(fd, 0o600);
  } finally {
    fs.closeSync(fd);
  }
  return inspected.contents;
}

function publishPrivateFile(file, contents) {
  const tmp = `${file}.tmp.${process.pid}.${crypto.randomBytes(8).toString('hex')}`;
  const fd = fs.openSync(tmp, fs.constants.O_WRONLY | fs.constants.O_CREAT |
    fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW || 0), 0o600);
  try {
    fs.writeFileSync(fd, `${contents}\n`);
    if (fs.fstatSync(fd).nlink !== 1) throw new Error('temporary identity file acquired another link');
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  try {
    fs.linkSync(tmp, file);
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

function fsyncDir(dir) {
  const fd = fs.openSync(dir, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

function ensureInstanceIdentity(paths) {
  let marker = readPrivateIdentity(paths.identityMarker, 'Redline instance identity marker');
  let identity = readPrivateIdentity(paths.identityFile, 'Redline instance identity');
  if (marker === null && identity !== null) {
    for (let attempt = 0; attempt < 20 && marker === null; attempt += 1) {
      sleepSync(10);
      marker = readPrivateIdentity(paths.identityMarker, 'Redline instance identity marker');
    }
  }
  if (marker !== null) {
    if (marker !== 'redline-instance-v1') throw new Error('Redline instance identity marker is corrupt');
    if (identity === null) throw new Error('Redline instance identity is missing after initialization');
    try { return parseInstanceId(identity); } catch { throw new Error('Redline instance identity is corrupt'); }
  }
  if (identity !== null) throw new Error('Redline instance identity state is incomplete');

  const candidate = `rli_${crypto.randomBytes(16).toString('hex')}`;
  try { publishPrivateFile(paths.identityFile, candidate); } catch (error) {
    if (error.code !== 'EEXIST') throw error;
  }
  identity = readPrivateIdentity(paths.identityFile, 'Redline instance identity');
  const winner = parseInstanceId(identity);
  try { publishPrivateFile(paths.identityMarker, 'redline-instance-v1'); } catch (error) {
    if (error.code !== 'EEXIST') throw error;
  }
  marker = readPrivateIdentity(paths.identityMarker, 'Redline instance identity marker');
  if (marker !== 'redline-instance-v1') throw new Error('Redline instance identity marker is corrupt');
  fsyncDir(paths.dir);
  return winner;
}

function processIsLive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

function parseLaunchMetadata(contents) {
  let value;
  try { value = JSON.parse(contents); } catch { throw new Error('sidecar.pid contains invalid launch metadata JSON'); }
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.version !== 1 ||
      !Number.isSafeInteger(value.pid) || value.pid <= 0 ||
      !Number.isSafeInteger(value.port) || value.port <= 0 || value.port > 65535 ||
      !value.directory || typeof value.directory !== 'object' || Array.isArray(value.directory) ||
      typeof value.directory.device !== 'string' || !/^(?:0|[1-9]\d*)$/.test(value.directory.device) ||
      typeof value.directory.inode !== 'string' || !/^(?:0|[1-9]\d*)$/.test(value.directory.inode)) {
    throw new Error('sidecar.pid contains invalid launch metadata');
  }
  try {
    parseInstanceId(value.instance_id);
    parseLaunchId(value.launch_id);
  } catch {
    throw new Error('sidecar.pid contains invalid launch metadata');
  }
  return value;
}

function readLaunchMetadata(paths) {
  const inspected = inspectLifecycleFile(paths.pidFile, 'sidecar.pid');
  if (!inspected) return null;
  const fd = fs.openSync(paths.pidFile, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    const opened = fs.fstatSync(fd);
    if (opened.nlink !== 1 || opened.dev !== inspected.before.dev || opened.ino !== inspected.before.ino) {
      throw new Error('sidecar.pid changed before permission repair');
    }
    fs.fchmodSync(fd, 0o600);
  } finally {
    fs.closeSync(fd);
  }
  if (/^[1-9]\d*\n?$/.test(inspected.rawContents)) {
    const pid = Number(inspected.contents);
    if (!Number.isSafeInteger(pid)) throw new Error('legacy sidecar.pid contains an unsafe PID');
    return { kind: 'legacy', pid, raw: inspected.contents };
  }
  return { kind: 'structured', metadata: parseLaunchMetadata(inspected.contents), raw: inspected.contents };
}

function metadataBelongsToDirectory(paths, metadata) {
  const current = directoryIdentity(paths.dir);
  return current.device === metadata.directory.device && current.inode === metadata.directory.inode;
}

function readManagedLaunch(paths) {
  const state = readLaunchMetadata(paths);
  if (!state) return null;
  if (state.kind === 'legacy') {
    const live = processIsLive(state.pid);
    return {
      ...state,
      legacy: true,
      live,
      managed: false,
    };
  }
  const { metadata } = state;
  const directoryMatches = metadataBelongsToDirectory(paths, metadata);
  const live = processIsLive(metadata.pid);
  return {
    ...state,
    legacy: false,
    pid: metadata.pid,
    port: metadata.port,
    directoryMatches,
    live,
    managed: false,
  };
}

function healthMatchesMetadata(health, metadata) {
  return health.kind === 'compatible' &&
    health.processId === metadata.pid &&
    health.instanceId === metadata.instance_id &&
    health.launchId === metadata.launch_id &&
    health.directory.device === metadata.directory.device &&
    health.directory.inode === metadata.directory.inode;
}

function inspectLock(lockDir) {
  let lock;
  try { lock = fs.lstatSync(lockDir); } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  if (!lock.isDirectory() || lock.isSymbolicLink()) {
    throw new Error('startup lock must be a real directory, not a symlink');
  }
  const ownerFile = path.join(lockDir, 'owner.pid');
  const owner = inspectLifecycleFile(ownerFile, 'lock owner');
  return { lock, ownerFile, owner };
}

function acquireLock(lockDir) {
  let staleChecks = 0;
  for (let attempt = 0; attempt < 200; attempt += 1) {
    try {
      fs.mkdirSync(lockDir, { mode: 0o700 });
      const ownerFile = path.join(lockDir, 'owner.pid');
      const fd = fs.openSync(ownerFile, fs.constants.O_WRONLY | fs.constants.O_CREAT |
        fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW || 0), 0o600);
      try {
        fs.writeFileSync(fd, `${process.pid}\n`);
        fs.fsyncSync(fd);
      } finally { fs.closeSync(fd); }
      return;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }

    const state = inspectLock(lockDir);
    if (!state) continue;
    const owner = state.owner?.contents;
    const live = /^[1-9]\d*$/.test(owner || '') && processIsLive(Number(owner));
    staleChecks = live ? 0 : staleChecks + 1;
    if (staleChecks >= 4) {
      if (state.owner) removeLifecycleFile(state.ownerFile, 'lock owner', owner);
      const current = fs.lstatSync(lockDir);
      if (!current.isDirectory() || current.isSymbolicLink() ||
          current.dev !== state.lock.dev || current.ino !== state.lock.ino) {
        throw new Error('startup lock changed before stale cleanup');
      }
      fs.rmdirSync(lockDir);
      staleChecks = 0;
      continue;
    }
    sleepSync(50);
  }
  throw new Error(`could not acquire startup lock ${lockDir} within 10 seconds; another command may be stuck`);
}

function releaseLock(lockDir) {
  let state;
  try { state = inspectLock(lockDir); } catch (error) {
    console.error(`Redline could not safely release startup lock: ${error.message}`);
    return;
  }
  if (!state) return;
  try {
    if (!state.owner || state.owner.contents !== String(process.pid)) {
      throw new Error('lock owner does not match launcher');
    }
    removeLifecycleFile(state.ownerFile, 'lock owner', process.pid);
    const current = fs.lstatSync(lockDir);
    if (!current.isDirectory() || current.isSymbolicLink() ||
        current.dev !== state.lock.dev || current.ino !== state.lock.ino) {
      throw new Error('startup lock changed');
    }
    fs.rmdirSync(lockDir);
  } catch (error) {
    console.error(`Redline could not safely release startup lock: ${error.message}`);
  }
}

function healthProbe(port) {
  return new Promise((resolve) => {
    let settled = false;
    let request;
    const deadline = setTimeout(() => {
      finish({ kind: 'incompatible', reason: 'health probe exceeded its 1500ms deadline' });
      if (request) request.destroy();
    }, 1500);
    function finish(result) {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      if (request) request.setTimeout(0);
      resolve(result);
    }
    request = http.get({ hostname: '127.0.0.1', port, path: '/health' }, (response) => {
      const chunks = [];
      let size = 0;
      response.on('data', (chunk) => {
        size += chunk.length;
        if (size > 64 * 1024) {
          finish({ kind: 'incompatible', reason: 'health response exceeds 64 KiB' });
          request.destroy();
        } else chunks.push(chunk);
      });
      response.on('end', () => {
        if (settled) return;
        if (response.statusCode !== 200) {
          finish({ kind: 'incompatible', reason: `health endpoint returned HTTP ${response.statusCode}` });
          return;
        }
        const compatibility = parseHealthResponse(Buffer.concat(chunks).toString('utf8'));
        finish(compatibility.compatible
          ? { kind: 'compatible', ...compatibility }
          : { kind: 'incompatible', reason: compatibility.reason });
      });
    });
    request.setTimeout(1000, () => {
      finish({ kind: 'incompatible', reason: 'health endpoint timed out' });
      request.destroy();
    });
    request.on('error', (error) => {
      finish(error.code === 'ECONNREFUSED'
        ? { kind: 'refused' }
        : { kind: 'incompatible', reason: `health probe failed: ${error.message}` });
    });
  });
}

function openPrivateLog(file) {
  let before;
  try { before = fs.lstatSync(file); } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    const fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_APPEND | fs.constants.O_CREAT |
      fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW || 0), 0o600);
    const created = fs.fstatSync(fd);
    if (!created.isFile() || created.nlink !== 1) {
      fs.closeSync(fd);
      throw new Error('new sidecar.log did not remain a private regular file');
    }
    return fd;
  }
  if (!before.isFile() || before.isSymbolicLink()) throw new Error('sidecar.log must be a regular file, not a symlink');
  if (before.nlink !== 1) throw new Error('sidecar.log has multiple links; refusing a hard link');
  const fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_APPEND | (fs.constants.O_NOFOLLOW || 0));
  const opened = fs.fstatSync(fd);
  if (!opened.isFile() || opened.nlink !== 1 || opened.dev !== before.dev || opened.ino !== before.ino) {
    fs.closeSync(fd);
    throw new Error('sidecar.log changed while it was being opened');
  }
  fs.fchmodSync(fd, 0o600);
  return fd;
}

async function terminateChild(child) {
  if (!child || child.exitCode !== null) return;
  child.kill('SIGTERM');
  for (let attempt = 0; attempt < 10 && child.exitCode === null; attempt += 1) await sleep(50);
  if (child.exitCode === null) child.kill('SIGKILL');
  if (child.exitCode === null) await Promise.race([
    new Promise((resolve) => child.once('exit', resolve)),
    sleep(500),
  ]);
}

function removeOwnedLaunchState(paths, pidTmp, metadata) {
  const expected = JSON.stringify(metadata);
  for (const file of [pidTmp, paths.pidFile]) {
    try { removeLifecycleFile(file, path.basename(file), expected); } catch {}
  }
}

function publishLaunchMetadata(paths, pidTmp, metadata) {
  const contents = JSON.stringify(metadata);
  const fd = fs.openSync(pidTmp, fs.constants.O_WRONLY | fs.constants.O_CREAT |
    fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW || 0), 0o600);
  try {
    fs.writeFileSync(fd, `${contents}\n`);
    if (fs.fstatSync(fd).nlink !== 1) throw new Error('temporary sidecar.pid acquired another link');
    fs.fsyncSync(fd);
  } finally { fs.closeSync(fd); }
  fs.linkSync(pidTmp, paths.pidFile);
  fs.unlinkSync(pidTmp);
  fsyncDir(paths.dir);
}

async function launchServer(paths, port, instanceId, env) {
  const pidTmp = `${paths.pidFile}.tmp.${crypto.randomBytes(12).toString('hex')}`;
  const launchId = `rll_${crypto.randomBytes(16).toString('hex')}`;
  const directory = directoryIdentity(paths.dir);
  const launchArguments = [
    `--redline-launch-id=${launchId}`,
    `--redline-dir-device=${directory.device}`,
    `--redline-dir-inode=${directory.inode}`,
  ];
  const logFd = openPrivateLog(paths.logFile);
  const child = spawn(process.execPath, [SERVER, ...launchArguments], {
    detached: true,
    stdio: ['ignore', logFd, logFd, 'ipc'],
    env: {
      ...env,
      REDLINE_DIR: paths.dir,
      REDLINE_PORT: String(port),
      REDLINE_INSTANCE_ID: instanceId,
      REDLINE_LAUNCH_ID: launchId,
      REDLINE_LAUNCH_PID_FILE: paths.pidFile,
      REDLINE_LAUNCH_PID_TMP: pidTmp,
      REDLINE_LAUNCH_LOCK_DIR: paths.lockDir,
      REDLINE_LAUNCH_LOCK_OWNER: String(process.pid),
    },
  });
  fs.closeSync(logFd);
  const metadata = {
    version: 1,
    pid: child.pid,
    port,
    instance_id: instanceId,
    launch_id: launchId,
    directory,
  };

  return await new Promise((resolve, reject) => {
    let settled = false;
    let publishing = false;
    const readinessTimeoutMs = Number.parseInt(process.env.REDLINE_READINESS_TIMEOUT_MS || '10000', 10);
    const timeout = setTimeout(() => fail(new Error(`Redline child did not signal readiness within ${Math.round(readinessTimeoutMs / 1000)} seconds`)), readinessTimeoutMs);
    const signalHandlers = new Map();

    function cleanupListeners() {
      clearTimeout(timeout);
      for (const [signal, handler] of signalHandlers) process.removeListener(signal, handler);
    }
    async function fail(error) {
      if (settled) return;
      settled = true;
      cleanupListeners();
      removeOwnedLaunchState(paths, pidTmp, metadata);
      await terminateChild(child);
      reject(error);
    }
    for (const [signal, code] of [['SIGHUP', 129], ['SIGINT', 130], ['SIGTERM', 143]]) {
      const handler = () => {
        const error = new Error(`Redline launcher received ${signal} before PID publication`);
        error.exitCode = code;
        fail(error);
      };
      signalHandlers.set(signal, handler);
      process.once(signal, handler);
    }
    child.on('error', (error) => fail(new Error(`Redline child could not start: ${error.message}`)));
    child.on('exit', (code, signal) => {
      if (!settled) fail(new Error(`Redline child exited before readiness (code ${code}, signal ${signal || 'none'})`));
    });
    child.on('message', async (message) => {
      if (settled || !message) return;
      if (message.type === 'redline-ready' && message.pid === child.pid &&
          message.instanceId === instanceId && message.launchId === launchId && !publishing) {
        publishing = true;
        try {
          if (env.NODE_ENV === 'test' && env.REDLINE_TEST_PAUSE_BEFORE_PID_PUBLISH_MS) {
            await sleep(Number(env.REDLINE_TEST_PAUSE_BEFORE_PID_PUBLISH_MS));
          }
          const health = await healthProbe(port);
          if (!healthMatchesMetadata(health, metadata)) {
            throw new Error(`health verification failed: ${health.reason || 'identity did not match the spawned Redline child'}`);
          }
          if (settled || child.exitCode !== null || !child.connected) return;
          publishLaunchMetadata(paths, pidTmp, metadata);
          if (env.NODE_ENV === 'test' && env.REDLINE_TEST_PAUSE_AFTER_PID_PUBLISH_MS) {
            await sleep(Number(env.REDLINE_TEST_PAUSE_AFTER_PID_PUBLISH_MS));
          }
          if (!settled) child.send({ type: 'redline-commit', pid: child.pid, instanceId, launchId });
        } catch (error) {
          fail(new Error(`Redline child could not publish readiness: ${error.message}`));
        }
        return;
      }
      if (message.type !== 'redline-committed' || message.pid !== child.pid ||
          message.instanceId !== instanceId || message.launchId !== launchId) return;
      settled = true;
      cleanupListeners();
      child.disconnect();
      child.unref();
      resolve(child.pid);
    });
  });
}

function reportCollision(port, reason) {
  console.error(`Redline cannot start: port ${port} is occupied by an incompatible service (${reason || 'no compatible Redline health response'}).`);
  if (port === 7878) {
    console.error('Stop the process using 127.0.0.1:7878, then run redline-sidecar start again. For unpacked development, choose another REDLINE_PORT.');
  } else {
    console.error('Stop the conflicting process or choose another REDLINE_PORT.');
  }
}

function reportUnmanagedCollision(paths, port) {
  console.error(`Redline cannot start: port ${port} is serving compatible Redline from another data directory or an unmanaged process.`);
  console.error(`Its PID or instance identity does not match REDLINE_DIR=${paths.dir}. Stop the other Redline instance or use its REDLINE_DIR.`);
}

function reportUnprovenLegacy(paths, pid) {
  console.error(`Redline found legacy numeric sidecar.pid for live PID ${pid}, but legacy ownership cannot be proven.`);
  console.error(`Verify PID ${pid} with "ps -p ${pid} -o command=", stop it if appropriate, remove ${paths.pidFile}, then run redline-sidecar start.`);
}

async function terminateManagedPid(pid) {
  process.kill(pid, 'SIGTERM');
  for (let attempt = 0; attempt < 20 && processIsLive(pid); attempt += 1) await sleep(50);
  if (processIsLive(pid)) process.kill(pid, 'SIGKILL');
  for (let attempt = 0; attempt < 10 && processIsLive(pid); attempt += 1) await sleep(25);
}

async function startCommand(env) {
  const port = parsePort(env.REDLINE_PORT ?? '7878');
  const paths = pathsFor(env);
  ensureDataDir(paths.dir, { create: true });
  const instanceId = ensureInstanceIdentity(paths);
  acquireLock(paths.lockDir);
  try {
    let existing = readManagedLaunch(paths);
    if (existing?.legacy) {
      if (!existing.live) {
        removeLifecycleFile(paths.pidFile, 'sidecar.pid', existing.raw);
        existing = null;
      } else {
        reportUnprovenLegacy(paths, existing.pid);
        return 1;
      }
    }
    const health = await healthProbe(port);
    if (health.kind === 'compatible') {
      const owner = readManagedLaunch(paths);
      if (!owner || owner.legacy || !owner.directoryMatches || owner.port !== port ||
          !healthMatchesMetadata(health, owner.metadata) || health.instanceId !== instanceId) {
        reportUnmanagedCollision(paths, port);
        return 1;
      }
      console.log(`already running (pid ${owner.pid}, port ${port})`);
      return 0;
    }
    if (health.kind === 'incompatible') {
      reportCollision(port, health.reason);
      return 1;
    }
    existing = readManagedLaunch(paths);
    if (existing?.live) {
      const existingHealth = existing.legacy ? null : await healthProbe(existing.port);
      if (!existing.legacy && existing.directoryMatches && healthMatchesMetadata(existingHealth, existing.metadata)) {
        console.error(`Redline cannot start: REDLINE_DIR=${paths.dir} already manages live Redline PID ${existing.pid}, but it is not serving compatible health on port ${port}.`);
        console.error('Stop that managed instance before changing REDLINE_PORT.');
      } else {
        console.error(`Redline cannot start: REDLINE_DIR=${paths.dir} contains live launch state that cannot be proven to belong to this directory.`);
        console.error('Inspect sidecar.pid and stop the existing process before retrying.');
      }
      return 1;
    }
    if (existing) removeLifecycleFile(paths.pidFile, 'sidecar.pid', existing.raw);
    let pid;
    try {
      pid = await launchServer(paths, port, instanceId, env);
    } catch (error) {
      if (error.exitCode) return error.exitCode;
      const after = await healthProbe(port);
      if (after.kind === 'compatible') reportUnmanagedCollision(paths, port);
      if (/^Redline child exited before readiness/.test(error.message)) {
        console.error(`Redline child failed before readiness; inspect ${paths.logFile}.`);
      } else {
        console.error(`${error.message}; inspect ${paths.logFile}.`);
      }
      return 1;
    }
    const published = readLaunchMetadata(paths);
    if (!published || published.metadata.pid !== pid || !metadataBelongsToDirectory(paths, published.metadata)) {
      console.error(`Redline child returned an invalid PID; inspect ${paths.logFile}.`);
      return 1;
    }
    console.log(`started (pid ${pid}, port ${port}, log ${paths.logFile})`);
    return 0;
  } finally {
    releaseLock(paths.lockDir);
  }
}

async function stopCommand(env) {
  const paths = pathsFor(env);
  if (!ensureDataDir(paths.dir, { create: false })) {
    console.log('not running');
    return 0;
  }
  acquireLock(paths.lockDir);
  try {
    const state = readManagedLaunch(paths);
    if (!state) {
      console.log('not running');
      return 0;
    }
    if (state.legacy) {
      if (!state.live) {
        removeLifecycleFile(paths.pidFile, 'sidecar.pid', state.raw);
        console.log('not running');
        return 0;
      }
      reportUnprovenLegacy(paths, state.pid);
      return 1;
    }
    if (!state.directoryMatches) {
      console.log('ignored copied or stale sidecar state for another REDLINE_DIR');
      return 1;
    }
    if (!state.live) {
      removeLifecycleFile(paths.pidFile, 'sidecar.pid', state.raw);
      console.log('not running');
      return 0;
    }
    const health = await healthProbe(state.port);
    if (!healthMatchesMetadata(health, state.metadata)) {
      console.log(`ignored stale pid file (pid ${state.pid} is not this Redline launch)`);
      return 1;
    }
    await terminateManagedPid(state.pid);
    removeLifecycleFile(paths.pidFile, 'sidecar.pid', state.raw);
    console.log(`stopped (pid ${state.pid})`);
    return 0;
  } finally {
    releaseLock(paths.lockDir);
  }
}

async function statusCommand(env) {
  const port = parsePort(env.REDLINE_PORT ?? '7878');
  const paths = pathsFor(env);
  if (!ensureDataDir(paths.dir, { create: false })) {
    console.log('down');
    return 1;
  }
  const state = readManagedLaunch(paths);
  if (state?.legacy) {
    if (!state.live) {
      removeLifecycleFile(paths.pidFile, 'sidecar.pid', state.raw);
      console.log('down');
      return 1;
    }
    reportUnprovenLegacy(paths, state.pid);
    console.log('down');
    return 1;
  }
  const instanceId = ensureInstanceIdentity(paths);
  const health = await healthProbe(port);
  if (health.kind === 'compatible') {
    const owner = readManagedLaunch(paths);
    if (!owner || owner.legacy || !owner.directoryMatches || owner.port !== port ||
        !healthMatchesMetadata(health, owner.metadata) || health.instanceId !== instanceId) {
      console.log(`collision (compatible Redline is not managed by REDLINE_DIR=${paths.dir})`);
      return 1;
    }
    console.log(`up (pid ${owner.pid}, port ${port})`);
    return 0;
  }
  console.log('down');
  return 1;
}

async function logsCommand(args, env) {
  const paths = pathsFor(env);
  if (!ensureDataDir(paths.dir, { create: false })) {
    console.log(`no logs yet at ${paths.logFile}`);
    return 0;
  }
  const log = inspectLifecycleFile(paths.logFile, 'sidecar.log', { read: false });
  if (!log) {
    console.log(`no logs yet at ${paths.logFile}`);
    return 0;
  }
  const tailArgs = args.includes('-f') || args.includes('--follow')
    ? ['-f', paths.logFile]
    : ['-n', env.LINES || '50', paths.logFile];
  const child = spawn('tail', tailArgs, { stdio: 'inherit' });
  return await new Promise((resolve) => child.once('exit', (code) => resolve(code || 0)));
}

async function foregroundCommand(env) {
  const port = parsePort(env.REDLINE_PORT ?? '7878');
  const paths = pathsFor(env);
  ensureDataDir(paths.dir, { create: true });
  const instanceId = ensureInstanceIdentity(paths);
  const launchId = `rll_${crypto.randomBytes(16).toString('hex')}`;
  const directory = directoryIdentity(paths.dir);
  const child = spawn(process.execPath, [SERVER,
    `--redline-launch-id=${launchId}`,
    `--redline-dir-device=${directory.device}`,
    `--redline-dir-inode=${directory.inode}`,
  ], {
    stdio: 'inherit',
    env: {
      ...env,
      REDLINE_DIR: paths.dir,
      REDLINE_PORT: String(port),
      REDLINE_INSTANCE_ID: instanceId,
      REDLINE_LAUNCH_ID: launchId,
    },
  });
  for (const signal of ['SIGHUP', 'SIGINT', 'SIGTERM']) process.once(signal, () => child.kill(signal));
  return await new Promise((resolve) => child.once('exit', (code, signal) => resolve(code ?? (signal ? 1 : 0))));
}

function helpText() {
  return `usage: redline-sidecar [SUBCOMMAND]

  start       (default) start as a detached background process and return when /health is up
  stop        stop the background process
  restart     stop + start
  status      check /health, exit non-zero if down
  logs [-f]   tail recent server logs (-f to follow)
  foreground  run the server in the current shell (blocks)

env: REDLINE_PORT (default 7878), REDLINE_DIR (default ~/.redline)
pid:  $REDLINE_DIR/sidecar.pid
log:  $REDLINE_DIR/sidecar.log`;
}

async function run(argv = process.argv.slice(2), env = process.env) {
  const command = argv[0] || 'start';
  try {
    if (command === 'help' || command === '-h' || command === '--help') {
      console.log(helpText());
      return 0;
    }
    if (command === 'logs') return await logsCommand(argv.slice(1), env);
    if (command === 'stop') return await stopCommand(env);
    if (command === 'start') return await startCommand(env);
    if (command === 'status') return await statusCommand(env);
    if (command === 'restart') {
      await stopCommand(env);
      await sleep(200);
      return await startCommand(env);
    }
    if (command === 'foreground' || command === 'fg' || command === 'run') return await foregroundCommand(env);
    console.error(`unknown subcommand: ${command} (try --help)`);
    return 1;
  } catch (error) {
    console.error(error.message);
    return 1;
  }
}

module.exports = {
  acquireLock,
  ensureDataDir,
  ensureInstanceIdentity,
  healthProbe,
  inspectLifecycleFile,
  parseLaunchMetadata,
  pathsFor,
  readLaunchMetadata,
  releaseLock,
  removeLifecycleFile,
  run,
};

if (require.main === module) {
  run().then((code) => { process.exitCode = code; });
}
