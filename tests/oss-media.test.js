const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const assetsDirectory = path.join(__dirname, '..', 'docs', 'oss', 'assets');
const videoPath = path.join(assetsDirectory, 'astrodev-real.mp4');
const posterPath = path.join(assetsDirectory, 'astrodev-real.png');
const maximumVideoBytes = 3 * 1024 * 1024;

function readBox(buffer, offset, limit) {
  if (offset + 8 > limit) {
    throw new Error(`Invalid MP4 box header at byte ${offset}`);
  }

  let size = buffer.readUInt32BE(offset);
  const type = buffer.toString('ascii', offset + 4, offset + 8);
  let headerSize = 8;

  if (size === 1) {
    if (offset + 16 > limit) {
      throw new Error(`Invalid extended MP4 box header at byte ${offset}`);
    }

    const extendedSize = buffer.readBigUInt64BE(offset + 8);
    if (extendedSize > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new Error(`MP4 box ${type} is too large to parse safely`);
    }
    size = Number(extendedSize);
    headerSize = 16;
  } else if (size === 0) {
    size = limit - offset;
  }

  if (size < headerSize || offset + size > limit) {
    throw new Error(`Invalid size for MP4 box ${type} at byte ${offset}`);
  }

  return {
    type,
    dataStart: offset + headerSize,
    end: offset + size,
  };
}

function findBox(buffer, start, end, expectedType) {
  let offset = start;

  while (offset < end) {
    const box = readBox(buffer, offset, end);
    if (box.type === expectedType) return box;
    offset = box.end;
  }

  throw new Error(`MP4 box ${expectedType} was not found`);
}

function readMp4DurationSeconds(filePath) {
  const buffer = fs.readFileSync(filePath);
  const moov = findBox(buffer, 0, buffer.length, 'moov');
  const mvhd = findBox(buffer, moov.dataStart, moov.end, 'mvhd');
  const version = buffer.readUInt8(mvhd.dataStart);

  if (version === 0) {
    if (mvhd.dataStart + 20 > mvhd.end) {
      throw new Error('MP4 mvhd version 0 box is truncated');
    }

    const timescale = buffer.readUInt32BE(mvhd.dataStart + 12);
    const duration = buffer.readUInt32BE(mvhd.dataStart + 16);
    if (timescale === 0) throw new Error('MP4 mvhd timescale must be positive');
    return duration / timescale;
  }

  if (version === 1) {
    if (mvhd.dataStart + 32 > mvhd.end) {
      throw new Error('MP4 mvhd version 1 box is truncated');
    }

    const timescale = buffer.readUInt32BE(mvhd.dataStart + 20);
    const duration = buffer.readBigUInt64BE(mvhd.dataStart + 24);
    if (timescale === 0) throw new Error('MP4 mvhd timescale must be positive');
    return Number(duration) / timescale;
  }

  throw new Error(`Unsupported MP4 mvhd version ${version}`);
}

test('AstroDev recording stays within web delivery limits', () => {
  const video = fs.statSync(videoPath);
  const durationSeconds = readMp4DurationSeconds(videoPath);

  assert.ok(video.isFile(), 'AstroDev recording must be a file');
  assert.ok(
    video.size < maximumVideoBytes,
    `AstroDev recording must stay below 3 MiB; received ${video.size} bytes`,
  );
  assert.ok(durationSeconds > 0, 'AstroDev recording must have a positive duration');
  assert.ok(
    durationSeconds <= 22,
    `AstroDev recording must be at most 22 seconds; received ${durationSeconds} seconds`,
  );
});

test('AstroDev recording has a non-empty poster', () => {
  const poster = fs.statSync(posterPath);

  assert.ok(poster.isFile(), 'AstroDev poster must be a file');
  assert.ok(poster.size > 0, 'AstroDev poster must not be empty');
});
