// Downloads GeoNames' cities15000 dump (every city with population >= 15000,
// https://download.geonames.org/export/dump/cities15000.zip, CC BY 4.0 —
// see README.md for attribution) and collapses it into a compact tab-separated
// data file the server loads at startup (src/cities.js) to power
// GET /api/v1/cities/search and GET /api/v1/cities/suggest.
//
// Run manually when the GeoNames data needs refreshing:
//   node scripts/build-cities-db.js
//
// No zip/unzip dependency was added for this one-off build step -- the zip
// has a single entry and standard (deflate) compression, so a small local
// ZIP central-directory reader + Node's built-in zlib.inflateRawSync covers
// it without a new package.json dependency.

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const CITIES_URL = 'https://download.geonames.org/export/dump/cities15000.zip';
const OUTPUT_PATH = path.join(__dirname, '..', 'src', 'data', 'cities.dat');
const ENTRY_NAME = 'cities15000.txt';

// A GeoNames alternatename is kept only if it adds real search value:
// long enough to be a real name (not a 1-char code), not just a re-casing of
// name/asciiname already stored, and not a bare number (some alternatename
// entries are administrative codes). Capped per city below to bound file size
// -- large capitals can otherwise carry 200+ alternatenames (historic names,
// every regional script, IATA-style short codes, etc.). GeoNames does not
// order this column by usefulness -- e.g. New York City's "Нью-Йорк" sits at
// raw index 76 and Astana's "Астана" at index 45 -- so a low cap taken in
// raw order would silently drop names real users search for (this data feeds
// GET /api/v1/cities/search, which must find "Нью-Йорк" -> New York City and
// "Астана" -> Astana). The cap is set generously high instead, just enough
// to guard against pathological outliers, not to trim normal capitals.
const MAX_ALTERNATENAMES_PER_CITY = 120;
const MIN_ALTERNATENAME_LENGTH = 2;

function extractZipEntry(zipBuffer, entryName) {
  const eocdSignature = 0x06054b50;
  let eocdOffset = -1;
  for (let i = zipBuffer.length - 22; i >= Math.max(0, zipBuffer.length - 66000); i -= 1) {
    if (zipBuffer.readUInt32LE(i) === eocdSignature) {
      eocdOffset = i;
      break;
    }
  }
  if (eocdOffset === -1) {
    throw new Error('ZIP end-of-central-directory record not found');
  }

  const totalEntries = zipBuffer.readUInt16LE(eocdOffset + 10);
  let centralDirOffset = zipBuffer.readUInt32LE(eocdOffset + 16);

  for (let i = 0; i < totalEntries; i += 1) {
    if (zipBuffer.readUInt32LE(centralDirOffset) !== 0x02014b50) {
      throw new Error(`Unexpected central directory signature at offset ${centralDirOffset}`);
    }
    const compressionMethod = zipBuffer.readUInt16LE(centralDirOffset + 10);
    const compressedSize = zipBuffer.readUInt32LE(centralDirOffset + 20);
    const fileNameLength = zipBuffer.readUInt16LE(centralDirOffset + 28);
    const extraFieldLength = zipBuffer.readUInt16LE(centralDirOffset + 30);
    const fileCommentLength = zipBuffer.readUInt16LE(centralDirOffset + 32);
    const localHeaderOffset = zipBuffer.readUInt32LE(centralDirOffset + 42);
    const fileName = zipBuffer.toString('utf8', centralDirOffset + 46, centralDirOffset + 46 + fileNameLength);

    if (fileName === entryName) {
      if (zipBuffer.readUInt32LE(localHeaderOffset) !== 0x04034b50) {
        throw new Error(`Unexpected local file header signature at offset ${localHeaderOffset}`);
      }
      const localFileNameLength = zipBuffer.readUInt16LE(localHeaderOffset + 26);
      const localExtraFieldLength = zipBuffer.readUInt16LE(localHeaderOffset + 28);
      const dataStart = localHeaderOffset + 30 + localFileNameLength + localExtraFieldLength;
      const compressedData = zipBuffer.subarray(dataStart, dataStart + compressedSize);

      if (compressionMethod === 0) {
        return compressedData;
      }
      if (compressionMethod === 8) {
        return zlib.inflateRawSync(compressedData);
      }
      throw new Error(`Unsupported ZIP compression method ${compressionMethod} for ${entryName}`);
    }

    centralDirOffset += 46 + fileNameLength + extraFieldLength + fileCommentLength;
  }

  throw new Error(`Entry ${entryName} not found in ZIP`);
}

function cleanAlternateNames(rawAlternateNames, name, asciiname) {
  if (!rawAlternateNames) {
    return [];
  }
  const excluded = new Set([name.toLowerCase(), asciiname.toLowerCase()]);
  const seen = new Set();
  const kept = [];
  for (const candidate of rawAlternateNames.split(',')) {
    const trimmed = candidate.trim();
    if (trimmed.length < MIN_ALTERNATENAME_LENGTH) continue;
    if (/^\d+$/.test(trimmed)) continue; // bare numeric/admin codes, not names
    const key = trimmed.toLowerCase();
    if (excluded.has(key) || seen.has(key)) continue;
    seen.add(key);
    kept.push(trimmed);
    if (kept.length >= MAX_ALTERNATENAMES_PER_CITY) break;
  }
  return kept;
}

async function main() {
  console.log(`Downloading ${CITIES_URL} ...`);
  const response = await fetch(CITIES_URL);
  if (!response.ok) {
    throw new Error(`Failed to download cities15000.zip: HTTP ${response.status}`);
  }
  const zipBuffer = Buffer.from(await response.arrayBuffer());
  console.log(`Downloaded ${zipBuffer.length} bytes, extracting ${ENTRY_NAME} ...`);

  const tsvBuffer = extractZipEntry(zipBuffer, ENTRY_NAME);
  const lines = tsvBuffer.toString('utf8').split('\n').filter((line) => line.trim());
  console.log(`Parsed ${lines.length} city rows, building compact data file ...`);

  const outputLines = [];
  for (const line of lines) {
    const fields = line.split('\t');
    // GeoNames cities15000.txt columns (tab-separated, no header row):
    // 0 geonameid, 1 name, 2 asciiname, 3 alternatenames, 4 latitude,
    // 5 longitude, 6 feature class, 7 feature code, 8 country code, ...
    // 14 population, ... 17 timezone, 18 modification date.
    const geonameId = fields[0];
    const name = fields[1];
    const asciiname = fields[2];
    const alternatenames = fields[3];
    const latitude = fields[4];
    const longitude = fields[5];
    const countryCode = fields[8];
    const population = fields[14];
    const timezone = fields[17];

    if (!geonameId || !name || !countryCode || !latitude || !longitude) {
      continue;
    }

    const kept = cleanAlternateNames(alternatenames, name, asciiname || name);
    outputLines.push([
      geonameId,
      name,
      asciiname || name,
      kept.join('|'),
      countryCode,
      latitude,
      longitude,
      timezone || '',
      population || '0',
    ].join('\t'));
  }

  fs.mkdirSync(path.dirname(OUTPUT_PATH), { recursive: true });
  fs.writeFileSync(OUTPUT_PATH, outputLines.join('\n') + '\n', 'utf8');

  const stat = fs.statSync(OUTPUT_PATH);
  console.log(`Wrote ${outputLines.length} cities to ${OUTPUT_PATH} (${(stat.size / (1024 * 1024)).toFixed(2)} MB)`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
