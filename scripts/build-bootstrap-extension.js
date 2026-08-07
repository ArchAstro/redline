#!/usr/bin/env node

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const bootstrapDir = path.join(root, 'store/bootstrap');
const manifestPath = path.join(bootstrapDir, 'manifest.json');
const iconPath = path.join(root, 'store/assets/icons/icon-128.png');
const expectedBootstrapVersion = '0.0.1';
const sourceAllowlist = ['index.html', 'manifest.json'];

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function localHeader(name, contents) {
  const nameBytes = Buffer.from(name);
  const header = Buffer.alloc(30);
  header.writeUInt32LE(0x04034b50, 0);
  header.writeUInt16LE(20, 4);
  header.writeUInt16LE(0x0800, 6);
  header.writeUInt16LE(0, 8);
  header.writeUInt16LE(0, 10);
  header.writeUInt16LE(0x0021, 12);
  header.writeUInt32LE(crc32(contents), 14);
  header.writeUInt32LE(contents.length, 18);
  header.writeUInt32LE(contents.length, 22);
  header.writeUInt16LE(nameBytes.length, 26);
  return Buffer.concat([header, nameBytes, contents]);
}

function centralHeader(name, contents, localOffset) {
  const nameBytes = Buffer.from(name);
  const header = Buffer.alloc(46);
  header.writeUInt32LE(0x02014b50, 0);
  header.writeUInt16LE(0x0314, 4);
  header.writeUInt16LE(20, 6);
  header.writeUInt16LE(0x0800, 8);
  header.writeUInt16LE(0, 10);
  header.writeUInt16LE(0, 12);
  header.writeUInt16LE(0x0021, 14);
  header.writeUInt32LE(crc32(contents), 16);
  header.writeUInt32LE(contents.length, 20);
  header.writeUInt32LE(contents.length, 24);
  header.writeUInt16LE(nameBytes.length, 28);
  header.writeUInt32LE(0x81a40000, 38);
  header.writeUInt32LE(localOffset, 42);
  return Buffer.concat([header, nameBytes]);
}

function endRecord(entryCount, centralSize, centralOffset) {
  const record = Buffer.alloc(22);
  record.writeUInt32LE(0x06054b50, 0);
  record.writeUInt16LE(entryCount, 8);
  record.writeUInt16LE(entryCount, 10);
  record.writeUInt32LE(centralSize, 12);
  record.writeUInt32LE(centralOffset, 16);
  return record;
}

function validateSourceNames() {
  const actual = fs.readdirSync(bootstrapDir, { withFileTypes: true })
    .map((entry) => entry.name)
    .sort();
  const unexpected = actual.filter((name) => !sourceAllowlist.includes(name));
  const missing = sourceAllowlist.filter((name) => !actual.includes(name));

  if (unexpected.length > 0) throw new Error(`Unexpected bootstrap source file: ${unexpected[0]}`);
  if (missing.length > 0) throw new Error(`Missing bootstrap source file: ${missing[0]}`);
}

function readRegularFileNoFollow(file, label) {
  const pathStat = fs.lstatSync(file);
  if (pathStat.isSymbolicLink()) throw new Error(`${label} must not be a symbolic link`);
  if (!pathStat.isFile()) throw new Error(`${label} is not a regular file`);

  let descriptor;
  try {
    descriptor = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const openedStat = fs.fstatSync(descriptor);
    if (!openedStat.isFile()) throw new Error(`${label} is not a regular file`);
    if (openedStat.dev !== pathStat.dev || openedStat.ino !== pathStat.ino) {
      throw new Error(`${label} changed while the bootstrap was being built`);
    }
    return fs.readFileSync(descriptor);
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function fsyncDirectory(directory) {
  let descriptor;
  try {
    descriptor = fs.openSync(directory, fs.constants.O_RDONLY);
    fs.fsyncSync(descriptor);
  } catch (error) {
    if (!['EINVAL', 'ENOTSUP'].includes(error.code)) throw error;
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function writeArchiveAtomically(outputPath, archive) {
  const outputDir = path.dirname(outputPath);
  const outputName = path.basename(outputPath, '.zip');
  fs.mkdirSync(outputDir, { recursive: true });

  const tempPath = path.join(
    outputDir,
    `.${outputName}.${process.pid}.${crypto.randomBytes(8).toString('hex')}.tmp`,
  );
  let descriptor;
  let pendingTemp = tempPath;

  try {
    descriptor = fs.openSync(
      tempPath,
      fs.constants.O_WRONLY
        | fs.constants.O_CREAT
        | fs.constants.O_EXCL
        | fs.constants.O_NOFOLLOW,
      0o644,
    );
    let offset = 0;
    while (offset < archive.length) {
      const written = fs.writeSync(descriptor, archive, offset, archive.length - offset, offset);
      if (written === 0) throw new Error('Bootstrap archive write made no progress');
      offset += written;
    }
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;

    fs.renameSync(tempPath, outputPath);
    pendingTemp = undefined;
    fsyncDirectory(outputDir);
  } catch (error) {
    if (descriptor !== undefined) {
      try {
        fs.closeSync(descriptor);
      } catch {
        // Preserve the original failure while still attempting temp cleanup.
      }
    }
    if (pendingTemp !== undefined) fs.rmSync(pendingTemp, { force: true });
    throw error;
  }
}

function build() {
  validateSourceNames();
  const manifestBytes = readRegularFileNoFollow(manifestPath, 'Bootstrap source manifest.json');
  let manifest;
  try {
    manifest = JSON.parse(manifestBytes.toString('utf8'));
  } catch (error) {
    throw new Error(`Bootstrap manifest is not valid JSON: ${error.message}`);
  }
  if (manifest.version !== expectedBootstrapVersion) {
    throw new Error(
      `Bootstrap manifest version must be ${expectedBootstrapVersion}; received ${manifest.version}`,
    );
  }

  const outputPath = path.join(
    root,
    `dist/redline-chrome-bootstrap-${manifest.version}.zip`,
  );
  const entries = [
    ['manifest.json', manifestBytes],
    [
      'index.html',
      readRegularFileNoFollow(path.join(bootstrapDir, 'index.html'), 'Bootstrap source index.html'),
    ],
    ['icon-128.png', readRegularFileNoFollow(iconPath, 'Bootstrap icon icon-128.png')],
  ];
  const localParts = [];
  const centralParts = [];
  let localOffset = 0;

  for (const [name, contents] of entries) {
    const local = localHeader(name, contents);
    localParts.push(local);
    centralParts.push(centralHeader(name, contents, localOffset));
    localOffset += local.length;
  }

  const central = Buffer.concat(centralParts);
  const archive = Buffer.concat([
    ...localParts,
    central,
    endRecord(entries.length, central.length, localOffset),
  ]);
  writeArchiveAtomically(outputPath, archive);
  process.stdout.write(`${path.relative(root, outputPath)}\n`);
}

try {
  build();
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
}
