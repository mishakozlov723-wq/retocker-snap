// The signed update manifest (latest.json) the app's updater reads (src-tauri/src/upd.rs).
//   UPDATE_KEY=<Ed25519 private key, PEM> node scripts/sign.mjs <exe> <version> [url] [out.json]
// The signature covers "retocker-snap:<version>:<sha256 of the exe>"; the app checks it with the public half of the key.
import { createHash, createPrivateKey, sign } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';

const [exe, ver, url0, out] = process.argv.slice(2);
const pem = process.env.UPDATE_KEY;
if (!exe || !ver || !pem) {
  console.error('usage: UPDATE_KEY=... node scripts/sign.mjs <exe> <version> [url] [out.json]');
  process.exit(2);
}
const data = readFileSync(exe);
const sha256 = createHash('sha256').update(data).digest('hex');
const sig = sign(null, Buffer.from(`retocker-snap:${ver}:${sha256}`), createPrivateKey(pem)).toString('hex');
// the notes: NOTES, or the first plain line of RELEASE.md
let notes = process.env.NOTES;
if (notes === undefined) {
  try {
    notes = readFileSync('RELEASE.md', 'utf8').split(/\r?\n/).map(s => s.trim()).find(s => s && !s.startsWith('#')) || '';
    notes = notes.replace(/\*\*|__|`/g, '');
  } catch { notes = ''; }
}
const url = url0 || `https://github.com/mishakozlov723-wq/retocker-snap-download/releases/download/v${ver}/Retocker-Snap-Setup.exe`;
const size = (data.length / 1048576).toFixed(1).replace('.', ',') + ' МБ';
const json = JSON.stringify({ version: ver, notes, size, bytes: data.length, url, sha256, sig }, null, 2) + '\n';
if (out) writeFileSync(out, json); else process.stdout.write(json);
