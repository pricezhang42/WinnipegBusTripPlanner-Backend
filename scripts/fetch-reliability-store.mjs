// Downloads the reliability store pinned in reliability-store.lock.json and checks
// its SHA-256. Dependency-free so the Docker runtime stage can run it:
//   node scripts/fetch-reliability-store.mjs [--lock FILE] [--out FILE]
// The backend serves reliability only from this file, so a missing lock is an error.
import { createHash } from 'node:crypto';
import { createReadStream, existsSync, mkdirSync, readFileSync, renameSync, rmSync, createWriteStream } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
export const LOCK_FILE = join(root, 'reliability-store.lock.json');
export const STORE_FILE = join(root, 'reliability', 'reliability.sqlite');

export function readLock(path) {
  const lock = JSON.parse(readFileSync(path, 'utf8'));
  if (!/^[0-9a-f]{64}$/.test(lock?.sha256 ?? '')) throw new Error('Lock file has no valid sha256.');
  if (typeof lock.url !== 'string' || !lock.url.startsWith('https://')) throw new Error('Lock file has no https url.');
  return lock;
}

export async function fileSha256(path) {
  const hash = createHash('sha256');
  await pipeline(createReadStream(path), hash);
  return hash.digest('hex');
}

export async function fetchStore(lockPath = LOCK_FILE, out = STORE_FILE, download = fetch) {
  if (!existsSync(lockPath)) throw new Error(`No reliability store is pinned: ${lockPath} is missing.`);
  const lock = readLock(lockPath);
  if (existsSync(out) && await fileSha256(out) === lock.sha256) return { status: 'present', file: out, sha256: lock.sha256 };
  mkdirSync(dirname(out), { recursive: true });
  const temporary = `${out}.download-${process.pid}`;
  try {
    const response = await download(lock.url, { redirect: 'follow' });
    if (!response.ok || !response.body) throw new Error(`Download failed with HTTP ${response.status}.`);
    await pipeline(Readable.fromWeb(response.body), createWriteStream(temporary));
    const sha256 = await fileSha256(temporary);
    if (sha256 !== lock.sha256) throw new Error(`Downloaded store has SHA-256 ${sha256}, lock expects ${lock.sha256}.`);
    renameSync(temporary, out);
    return { status: 'downloaded', file: out, sha256 };
  } finally {
    rmSync(temporary, { force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const option = (name, fallback) => {
    const index = args.indexOf(name);
    return index === -1 ? fallback : resolve(args[index + 1]);
  };
  fetchStore(option('--lock', LOCK_FILE), option('--out', STORE_FILE))
    .then(result => console.log(JSON.stringify(result)))
    .catch(error => { console.error(error.message); process.exitCode = 1; });
}
