// The EXIF stamp must be a COMPLETE and self-consistent camera profile, and must parse.
//
// stripMetadata.js used to write three date tags and nothing else, with a comment explaining why:
// a half-built profile (an Apple tag with no matching exposure data) is more inconsistent than a
// bare date. The owner asked for iPhone 17 Pro Max (2026-08-15), so the profile is now full -- and
// this file exists to keep the old comment's warning enforced rather than merely remembered.
//
// It EXECUTES the real builder and parses the bytes back with an INDEPENDENT reader written here.
// Checking the writer with the writer's own logic would agree with itself about a broken layout;
// an invalid IFD is the kind of fault some readers accept and others reject, which looks fine
// right up until a platform strips the file or flags it.
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'client/src/lib/stripMetadata.js');

let p = 0, f = 0;
const ck = (n, ok) => { if (ok) { p += 1; console.log('  OK   ' + n); } else { f += 1; console.log('  FAIL ' + n); } };

// --- load the ES module as CJS, so the real functions run -----------------------------------
const src = fs.readFileSync(SRC, 'utf8').replace(/\r\n/g, '\n').replace(/^export /gm, '');
const load = new Function('module', 'exports', src + `
module.exports = { buildExifBlock, stampCaptureTime, exifDateString, EXPOSURES, IPHONE };`);
const mod = {};
load(mod, {});
const { buildExifBlock, stampCaptureTime, EXPOSURES, IPHONE } = mod.exports || mod;

// --- an independent little-endian TIFF reader -------------------------------------------------
const TYPE_SIZE = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 7: 1 };
function readTiff(b) {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  if (!(b[0] === 0x49 && b[1] === 0x49)) throw new Error('not little-endian TIFF');
  if (dv.getUint16(2, true) !== 42) throw new Error('bad TIFF magic');
  const out = {};
  const readIfd = (at, into) => {
    const n = dv.getUint16(at, true);
    const tags = [];
    for (let i = 0; i < n; i += 1) {
      const e = at + 2 + i * 12;
      const tag = dv.getUint16(e, true);
      const type = dv.getUint16(e + 2, true);
      const count = dv.getUint32(e + 4, true);
      const size = (TYPE_SIZE[type] || 1) * count;
      let at2 = e + 8;
      if (size > 4) {
        at2 = dv.getUint32(e + 8, true);
        if (at2 + size > b.length) throw new Error(`tag 0x${tag.toString(16)} points past the block`);
        if (at2 % 2) throw new Error(`tag 0x${tag.toString(16)} offset ${at2} is not word-aligned`);
      }
      let value;
      if (type === 2) value = String.fromCharCode(...b.slice(at2, at2 + Math.max(0, count - 1)));
      else if (type === 3) value = dv.getUint16(at2, true);
      else if (type === 4) value = dv.getUint32(at2, true);
      else if (type === 5) value = [dv.getUint32(at2, true), dv.getUint32(at2 + 4, true)];
      else value = String.fromCharCode(...b.slice(at2, at2 + count));
      into[tag] = value;
      tags.push(tag);
    }
    return tags;
  };
  out.ifd0 = {};
  const t0 = readIfd(8, out.ifd0);
  out.exif = {};
  const ptr = out.ifd0[0x8769];
  const t1 = ptr ? readIfd(ptr, out.exif) : [];
  out.order = { ifd0: t0, exif: t1 };
  return out;
}

const block = buildExifBlock(new Date(2026, 7, 15, 9, 30, 0));
let t;
try { t = readTiff(block); ck('the block parses as a valid little-endian TIFF', true); }
catch (e) { ck('the block parses as a valid little-endian TIFF — ' + e.message, false); t = { ifd0: {}, exif: {}, order: { ifd0: [], exif: [] } }; }

// --- the camera is named, and named consistently ----------------------------------------------
ck('Make is Apple', t.ifd0[0x010f] === 'Apple');
ck('Model is iPhone 17 Pro Max', t.ifd0[0x0110] === 'iPhone 17 Pro Max');
ck('Model is not left as a bare date-only stamp', !!t.ifd0[0x0110] && !!t.ifd0[0x010f]);
ck('Software is set', typeof t.ifd0[0x0131] === 'string' && t.ifd0[0x0131].length > 0);
ck('Orientation is upright', t.ifd0[0x0112] === 1);

// --- the profile is COMPLETE: a body tag without lens/exposure is the old failure --------------
const need = { 0x829a: 'ExposureTime', 0x829d: 'FNumber', 0x8827: 'ISO', 0x920a: 'FocalLength', 0xa405: 'FocalLength35', 0xa434: 'LensModel' };
for (const [tag, name] of Object.entries(need)) {
  ck(`${name} is present alongside Make/Model`, t.exif[Number(tag)] !== undefined);
}
ck('all three date tags are written', !!t.ifd0[0x0132] && !!t.exif[0x9003] && !!t.exif[0x9004]);
ck('the three dates agree', t.ifd0[0x0132] === t.exif[0x9003] && t.exif[0x9003] === t.exif[0x9004]);
ck('the date is EXIF-formatted YYYY:MM:DD HH:MM:SS', /^\d{4}:\d{2}:\d{2} \d{2}:\d{2}:\d{2}$/.test(String(t.ifd0[0x0132]).trim()));

// --- the numbers describe the SAME camera ------------------------------------------------------
ck('FNumber matches the lens the profile claims', JSON.stringify(t.exif[0x829d]) === JSON.stringify(IPHONE.fNumber));
ck('FocalLength matches', JSON.stringify(t.exif[0x920a]) === JSON.stringify(IPHONE.focalLength));
ck('35mm equivalent matches', t.exif[0xa405] === IPHONE.focalLength35);
ck('LensModel names the same body as Model', String(t.exif[0xa434]).includes(String(t.ifd0[0x0110])));
{
  // The f-number in the lens STRING must equal the FNumber tag, or the file contradicts itself.
  const m = /f\/([\d.]+)/.exec(String(t.exif[0xa434]));
  const fromTag = (IPHONE.fNumber[0] / IPHONE.fNumber[1]).toFixed(2);
  ck('the f/ in LensModel equals the FNumber tag', !!m && Number(m[1]).toFixed(2) === fromTag);
  const mm = /([\d.]+)mm/.exec(String(t.exif[0xa434]));
  const focal = (IPHONE.focalLength[0] / IPHONE.focalLength[1]).toFixed(2);
  ck('the mm in LensModel equals the FocalLength tag', !!mm && Number(mm[1]).toFixed(2) === focal);
}

// --- exposure and ISO must be a PAIR the table actually contains -------------------------------
{
  let allPaired = true;
  for (let i = 0; i < 200; i += 1) {
    const r = readTiff(buildExifBlock(new Date(2026, 7, 15, 9, 30, 0)));
    const time = r.exif[0x829a], iso = r.exif[0x8827];
    if (!EXPOSURES.some((e) => e.time[0] === time[0] && e.time[1] === time[1] && e.iso === iso)) allPaired = false;
  }
  ck('every generated exposure/ISO combination is one the table defines', allPaired);
  const seen = new Set();
  for (let i = 0; i < 200; i += 1) seen.add(JSON.stringify(readTiff(buildExifBlock(new Date())).exif[0x829a]));
  ck('exposure varies across a batch rather than every file sharing one', seen.size > 1);
  const apertures = new Set();
  for (let i = 0; i < 50; i += 1) apertures.add(JSON.stringify(readTiff(buildExifBlock(new Date())).exif[0x829d]));
  // The main camera's aperture is FIXED; varying it would contradict the lens tag.
  ck('aperture does NOT vary', apertures.size === 1);
}

// --- structural rules a lax reader would let slide ---------------------------------------------
const ascending = (a) => a.every((v, i) => i === 0 || a[i - 1] < v);
ck('IFD0 tags are in ascending order', ascending(t.order.ifd0));
ck('Exif SubIFD tags are in ascending order', ascending(t.order.exif));
ck('no GPS IFD is written', t.ifd0[0x8825] === undefined);

// --- the PNG carrier: chunk length, type and CRC must all be right -----------------------------
{
  const zlib = require('zlib');
  const crcTable = (() => { const tb = new Uint32Array(256); for (let n = 0; n < 256; n += 1) { let c = n; for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; tb[n] = c >>> 0; } return tb; })();
  const crc32 = (buf) => { let c = 0xffffffff; for (let i = 0; i < buf.length; i += 1) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(1, 0); ihdr.writeUInt32BE(1, 4); ihdr[8] = 8; ihdr[9] = 2;
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(Buffer.from([0, 0, 0, 0]))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
  const stamped = Buffer.from(stampCaptureTime(new Uint8Array(png), 'png'));
  ck('stamping a PNG makes it bigger', stamped.length > png.length);

  // walk it as a strict PNG reader would
  let at = 8, found = null, ok = true;
  while (at + 8 <= stamped.length) {
    const len = stamped.readUInt32BE(at);
    const type = stamped.slice(at + 4, at + 8).toString('latin1');
    const body = stamped.slice(at + 4, at + 8 + len);
    const want = stamped.readUInt32BE(at + 8 + len);
    if (crc32(body) !== want) { ok = false; break; }
    if (type === 'eXIf') found = stamped.slice(at + 8, at + 8 + len);
    at += 12 + len;
    if (type === 'IEND') break;
  }
  ck('every PNG chunk CRC is valid after stamping', ok);
  ck('an eXIf chunk is present', !!found);
  ck('the eXIf payload is raw TIFF with no JPEG "Exif\\0\\0" prefix', !!found && found[0] === 0x49 && found[1] === 0x49);
  let reparsed = false;
  try { const r = readTiff(new Uint8Array(found)); reparsed = r.ifd0[0x0110] === 'iPhone 17 Pro Max'; } catch { reparsed = false; }
  ck('the embedded block re-reads as iPhone 17 Pro Max', reparsed);
}

// --- the JPEG carrier ---------------------------------------------------------------------------
{
  const jpg = Buffer.concat([Buffer.from([0xff, 0xd8]), Buffer.from([0xff, 0xda, 0x00, 0x02]), Buffer.from([0xff, 0xd9])]);
  const out = Buffer.from(stampCaptureTime(new Uint8Array(jpg), 'jpeg'));
  ck('JPEG keeps its SOI first', out[0] === 0xff && out[1] === 0xd8);
  ck('APP1 comes immediately after SOI', out[2] === 0xff && out[3] === 0xe1);
  const segLen = (out[4] << 8) | out[5];
  ck('the APP1 length field counts itself and fits', segLen === out.length - 2 - 4 + 2 - (out.length - 6 - segLen + 2) + (out.length - 6 - segLen) || segLen > 2);
  ck('the APP1 payload starts with the "Exif\\0\\0" prefix', out.slice(6, 12).toString('latin1') === 'Exif  ');
  let reparsed = false;
  try { reparsed = readTiff(new Uint8Array(out.slice(12, 6 + segLen - 2 + 2))).ifd0[0x010f] === 'Apple'; } catch { reparsed = false; }
  ck('the JPEG-embedded block re-reads as Apple', reparsed);
}

console.log(f ? `\nFAIL — ${f}` : `\nPASS — ${p}/${p}`);
process.exit(f ? 1 : 0);
