import { readFileSync } from 'node:fs';
import { resolve, sep } from 'node:path';
export type Sharded<T> = { groups: Record<string, T>; routeFiles?: Record<string, string>; rootDirectory?: string };
// Limit memory independently of the number of years and routes in the export.
const cache = new Map<string, { groups: Record<string, unknown>; bytes: number }>();
const MAX_BYTES = 12 * 1024 * 1024;
export function artifactGroups<T>(data: Sharded<T>, route: string): Record<string, T> {
  if (!data.routeFiles) return data.groups;
  const file = data.routeFiles[route];
  if (!data.rootDirectory || typeof file !== 'string') return {};
  const root = resolve(data.rootDirectory); const path = resolve(root, file);
  if (!path.startsWith(root + sep)) return {};
  const hit = cache.get(path);
  if (hit) { cache.delete(path); cache.set(path, hit); return hit.groups as Record<string, T>; }
  try {
    const raw = readFileSync(path, 'utf8'); const value = JSON.parse(raw);
    if (!value.groups || typeof value.groups !== 'object' || Array.isArray(value.groups)) return {};
    if (Buffer.byteLength(raw) <= MAX_BYTES) {
      let bytes = [...cache.values()].reduce((n, v) => n + v.bytes, 0);
      while (cache.size && (cache.size >= 4 || bytes + Buffer.byteLength(raw) > MAX_BYTES)) {
        const key = cache.keys().next().value!; bytes -= cache.get(key)!.bytes; cache.delete(key);
      }
      cache.set(path, { groups: value.groups, bytes: Buffer.byteLength(raw) });
    }
    return value.groups;
  } catch { return {}; }
}
