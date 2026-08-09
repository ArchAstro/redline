const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const zlib = require('node:zlib');

const root = path.join(__dirname, '..');
const bootstrapDir = path.join(root, 'store/bootstrap');
const distDir = path.join(root, 'dist');
const archivePath = path.join(root, 'dist/redline-chrome-bootstrap-0.0.1.zip');
const expectedSha256 = '2524eb58d0ab4f7999104821e279dd2659848e139ac6c8db1d7150fc8944a1b0';

function runBuilder() {
  return spawnSync(process.execPath, ['scripts/build-bootstrap-extension.js'], {
    cwd: root,
    encoding: 'utf8',
  });
}

function listBootstrapTempFiles() {
  if (!fs.existsSync(distDir)) return [];
  return fs.readdirSync(distDir)
    .filter((name) => /^\.redline-chrome-bootstrap-0\.0\.1\..+\.tmp$/.test(name))
    .sort();
}

function assertArtifactUnchanged(before) {
  assert.deepEqual(fs.readFileSync(archivePath), before.bytes);
  const afterStat = fs.statSync(archivePath, { bigint: true });
  assert.equal(afterStat.ino, before.stat.ino);
  assert.equal(afterStat.mtimeNs, before.stat.mtimeNs);
}

function assertBuilderRejectsSymlink(relativeSource, outsideContents) {
  const baseline = runBuilder();
  assert.equal(baseline.status, 0, baseline.stderr || baseline.stdout);
  const artifactBefore = {
    bytes: fs.readFileSync(archivePath),
    stat: fs.statSync(archivePath, { bigint: true }),
  };
  const source = path.join(root, relativeSource);
  const original = fs.readFileSync(source);
  const originalMode = fs.statSync(source).mode;
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'redline-bootstrap-symlink-'));
  const outside = path.join(tempDir, path.basename(source));
  fs.writeFileSync(outside, outsideContents);
  fs.unlinkSync(source);
  fs.symlinkSync(outside, source);

  try {
    const result = runBuilder();
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /symbolic link/i);
    assertArtifactUnchanged(artifactBefore);
  } finally {
    fs.rmSync(source, { force: true });
    fs.writeFileSync(source, original, { mode: originalMode });
    fs.rmSync(tempDir, { recursive: true, force: true });
    if (!fs.existsSync(archivePath) || !fs.readFileSync(archivePath).equals(artifactBefore.bytes)) {
      fs.mkdirSync(path.dirname(archivePath), { recursive: true });
      fs.writeFileSync(archivePath, artifactBefore.bytes);
    }
  }
}

function readStoredZip(file) {
  const bytes = fs.readFileSync(file);
  const entries = new Map();
  let offset = 0;

  while (bytes.readUInt32LE(offset) === 0x04034b50) {
    const method = bytes.readUInt16LE(offset + 8);
    const compressedSize = bytes.readUInt32LE(offset + 18);
    const uncompressedSize = bytes.readUInt32LE(offset + 22);
    const nameLength = bytes.readUInt16LE(offset + 26);
    const extraLength = bytes.readUInt16LE(offset + 28);
    const nameStart = offset + 30;
    const dataStart = nameStart + nameLength + extraLength;
    const name = bytes.subarray(nameStart, nameStart + nameLength).toString('utf8');
    const compressed = bytes.subarray(dataStart, dataStart + compressedSize);
    const contents = method === 0 ? compressed : zlib.inflateRawSync(compressed);

    assert.equal(contents.length, uncompressedSize, `${name} has the declared size`);
    entries.set(name, contents);
    offset = dataStart + compressedSize;
  }

  assert.equal(bytes.readUInt32LE(offset), 0x02014b50, 'archive has a central directory');
  return entries;
}

function parsePng(png) {
  assert.deepEqual(png.subarray(0, 8), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  const width = png.readUInt32BE(16);
  const height = png.readUInt32BE(20);
  const colorType = png[25];
  const idat = [];
  let offset = 8;

  while (offset < png.length) {
    const length = png.readUInt32BE(offset);
    const type = png.subarray(offset + 4, offset + 8).toString('ascii');
    if (type === 'IDAT') idat.push(png.subarray(offset + 8, offset + 8 + length));
    offset += 12 + length;
    if (type === 'IEND') break;
  }

  assert.equal(colorType, 6, 'icon uses RGBA pixels');
  const pixels = zlib.inflateSync(Buffer.concat(idat));
  const stride = width * 4;
  const rows = [];
  let previous = Buffer.alloc(stride);

  function paeth(left, up, upperLeft) {
    const estimate = left + up - upperLeft;
    const leftDistance = Math.abs(estimate - left);
    const upDistance = Math.abs(estimate - up);
    const upperLeftDistance = Math.abs(estimate - upperLeft);
    if (leftDistance <= upDistance && leftDistance <= upperLeftDistance) return left;
    if (upDistance <= upperLeftDistance) return up;
    return upperLeft;
  }

  for (let y = 0; y < height; y += 1) {
    const filter = pixels[y * (stride + 1)];
    const raw = pixels.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const row = Buffer.alloc(stride);
    for (let x = 0; x < stride; x += 1) {
      const left = x >= 4 ? row[x - 4] : 0;
      const up = previous[x];
      const upperLeft = x >= 4 ? previous[x - 4] : 0;
      if (filter === 0) row[x] = raw[x];
      else if (filter === 1) row[x] = (raw[x] + left) & 0xff;
      else if (filter === 2) row[x] = (raw[x] + up) & 0xff;
      else if (filter === 3) row[x] = (raw[x] + Math.floor((left + up) / 2)) & 0xff;
      else if (filter === 4) row[x] = (raw[x] + paeth(left, up, upperLeft)) & 0xff;
      else assert.fail(`unsupported PNG filter ${filter}`);
    }
    rows.push(row);
    previous = row;
  }

  return { width, height, pixels: Buffer.concat(rows) };
}

test('bootstrap builder creates the inert identity-reservation archive deterministically', () => {
  fs.rmSync(archivePath, { force: true });

  const first = runBuilder();
  assert.equal(first.status, 0, first.stderr || first.stdout);
  const firstBytes = fs.readFileSync(archivePath);
  const firstHash = crypto.createHash('sha256').update(firstBytes).digest('hex');

  const second = runBuilder();
  assert.equal(second.status, 0, second.stderr || second.stdout);
  const secondBytes = fs.readFileSync(archivePath);
  const secondHash = crypto.createHash('sha256').update(secondBytes).digest('hex');

  assert.equal(firstHash, expectedSha256);
  assert.equal(secondHash, expectedSha256);
  assert.deepEqual(secondBytes, firstBytes);

  const unzip = spawnSync('unzip', ['-t', archivePath], { encoding: 'utf8' });
  assert.equal(unzip.status, 0, unzip.stderr || unzip.stdout);
  assert.equal(unzip.stderr, '');
  assert.match(unzip.stdout, /No errors detected in compressed data/);

  const entries = readStoredZip(archivePath);
  assert.deepEqual([...entries.keys()], ['manifest.json', 'index.html', 'icon-128.png']);

  const manifest = JSON.parse(entries.get('manifest.json').toString('utf8'));
  assert.deepEqual(manifest, {
    manifest_version: 3,
    name: 'Redline by ArchAstro',
    short_name: 'Redline',
    version: '0.0.1',
    description: 'Unpublished item that only reserves Redline\'s Chrome Web Store identity.',
    icons: { 128: 'icon-128.png' },
  });

  const html = entries.get('index.html').toString('utf8');
  assert.match(html, /unpublished/i);
  assert.match(html, /only reserves Redline's Chrome Web Store identity/i);
  assert.match(html, /not the functional release/i);
  assert.doesNotMatch(html, /install|ready to use|start|try|launch/i);
  assert.doesNotMatch(html, /<script|<link|\son\w+=/i);

  const joinedText = [...entries.values()].map((entry) => entry.toString('utf8')).join('\n');
  assert.doesNotMatch(joinedText, /permissions|host_permissions|content_scripts|service_worker|background|https?:\/\/|token|secret|placeholder|TODO|REPLACE/i);

  const png = parsePng(entries.get('icon-128.png'));
  assert.deepEqual([png.width, png.height], [128, 128]);
  const opaquePixels = [];
  for (let offset = 0; offset < png.pixels.length; offset += 4) {
    if (png.pixels[offset + 3] > 0) opaquePixels.push(png.pixels.subarray(offset, offset + 4).toString('hex'));
  }
  assert.ok(opaquePixels.length > 4096, 'icon has substantial nontransparent artwork');
  assert.ok(new Set(opaquePixels).size >= 3, 'icon is not a blank or single-color image');
});

test('bootstrap builder rejects unexpected source files', () => {
  const unexpected = path.join(bootstrapDir, 'unexpected.txt');
  fs.writeFileSync(unexpected, 'must not be packaged\n');
  try {
    const result = runBuilder();
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /unexpected bootstrap source file: unexpected\.txt/i);
  } finally {
    fs.rmSync(unexpected, { force: true });
  }
});

test('bootstrap builder rejects a symlinked placeholder page without replacing the artifact', () => {
  assertBuilderRejectsSymlink(
    'store/bootstrap/index.html',
    '<!doctype html><title>Outside bootstrap page</title>\n',
  );
});

test('bootstrap builder rejects a symlinked manifest without replacing the artifact', () => {
  assertBuilderRejectsSymlink(
    'store/bootstrap/manifest.json',
    `${JSON.stringify({ manifest_version: 3, version: '0.0.1', name: 'Outside manifest' })}\n`,
  );
});

test('bootstrap builder rejects a symlinked icon without replacing the artifact', () => {
  assertBuilderRejectsSymlink('store/assets/icons/icon-128.png', 'outside icon bytes\n');
});

test('bootstrap builder derives and validates the immutable manifest version before writing', () => {
  const baseline = runBuilder();
  assert.equal(baseline.status, 0, baseline.stderr || baseline.stdout);
  const artifactBefore = {
    bytes: fs.readFileSync(archivePath),
    stat: fs.statSync(archivePath, { bigint: true }),
  };
  const manifestPath = path.join(bootstrapDir, 'manifest.json');
  const original = fs.readFileSync(manifestPath, 'utf8');
  const manifest = JSON.parse(original);
  manifest.version = '0.0.2';
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  try {
    const result = runBuilder();
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /bootstrap manifest version must be 0\.0\.1; received 0\.0\.2/i);
    assert.equal(fs.existsSync(path.join(root, 'dist/redline-chrome-bootstrap-0.0.2.zip')), false);
    assertArtifactUnchanged(artifactBefore);
  } finally {
    fs.writeFileSync(manifestPath, original);
    if (!fs.existsSync(archivePath) || !fs.readFileSync(archivePath).equals(artifactBefore.bytes)) {
      fs.mkdirSync(path.dirname(archivePath), { recursive: true });
      fs.writeFileSync(archivePath, artifactBefore.bytes);
    }
  }
});

test('a real file-size write failure preserves the prior archive and removes temporary files', () => {
  const baseline = runBuilder();
  assert.equal(baseline.status, 0, baseline.stderr || baseline.stdout);
  const priorBytes = fs.readFileSync(archivePath);
  const priorHash = crypto.createHash('sha256').update(priorBytes).digest('hex');
  assert.equal(priorHash, expectedSha256);
  assert.deepEqual(listBootstrapTempFiles(), []);

  const constrained = spawnSync(
    'bash',
    ['-c', 'ulimit -f 1; exec "$@"', 'redline-bootstrap', process.execPath, 'scripts/build-bootstrap-extension.js'],
    { cwd: root, encoding: 'utf8' },
  );

  try {
    assert.ok(
      constrained.status !== 0 || constrained.signal !== null,
      `constrained build unexpectedly succeeded:\n${constrained.stdout}${constrained.stderr}`,
    );
    assert.equal(fs.existsSync(archivePath), true);
    const afterBytes = fs.readFileSync(archivePath);
    const afterHash = crypto.createHash('sha256').update(afterBytes).digest('hex');
    assert.equal(afterHash, priorHash);
    assert.deepEqual(afterBytes, priorBytes);
    assert.deepEqual(listBootstrapTempFiles(), []);
  } finally {
    for (const name of listBootstrapTempFiles()) fs.rmSync(path.join(distDir, name), { force: true });
    if (!fs.existsSync(archivePath) || !fs.readFileSync(archivePath).equals(priorBytes)) {
      fs.mkdirSync(distDir, { recursive: true });
      fs.writeFileSync(archivePath, priorBytes);
    }
  }
});

test('a final-output symlink is replaced without changing its outside target', () => {
  const baseline = runBuilder();
  assert.equal(baseline.status, 0, baseline.stderr || baseline.stdout);
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'redline-bootstrap-output-'));
  const outsideTarget = path.join(tempDir, 'outside.zip');
  const outsideBytes = Buffer.from('outside target must remain unchanged\n');
  fs.writeFileSync(outsideTarget, outsideBytes);
  fs.rmSync(archivePath, { force: true });
  fs.symlinkSync(outsideTarget, archivePath);

  try {
    const result = runBuilder();
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.deepEqual(fs.readFileSync(outsideTarget), outsideBytes);
    const outputStat = fs.lstatSync(archivePath);
    assert.equal(outputStat.isSymbolicLink(), false);
    assert.equal(outputStat.isFile(), true);
    const outputHash = crypto.createHash('sha256').update(fs.readFileSync(archivePath)).digest('hex');
    assert.equal(outputHash, expectedSha256);
    assert.deepEqual(listBootstrapTempFiles(), []);
  } finally {
    fs.rmSync(archivePath, { force: true });
    fs.rmSync(tempDir, { recursive: true, force: true });
    const restored = runBuilder();
    assert.equal(restored.status, 0, restored.stderr || restored.stdout);
  }
});
