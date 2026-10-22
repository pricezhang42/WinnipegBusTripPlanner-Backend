import { readFileSync } from 'node:fs';
import { reliabilityStore } from './reliabilityStore.js';

export type DestinationRide = {
  route?: { key?: string | number; name?: string };
  variant?: { key?: string; name?: string };
};
export type DestinationEntry = {
  route: string;
  destination: string;
  displayNames: string[];
  source: 'variant-api' | 'exact-display-fallback';
};
export type DestinationLookup = {
  schemaVersion: 1;
  generatedAt: string;
  historySourceSha256: string;
  variants: Record<string, DestinationEntry>;
};
export type DestinationUnavailableReason =
  | 'destination_variant_route_mismatch'
  | 'destination_variant_changed'
  | 'destination_variant_unknown'
  | 'destination_metadata_missing';
export type DestinationResolution =
  | { status: 'resolved'; destination: string }
  | { status: 'unavailable'; reason: DestinationUnavailableReason };

export function normalizeDestinationName(value: string): string {
  return value.trim().toLowerCase();
}

/** Retain the old exact-name cases; do not split arbitrary text at "to" or "via". */
export function exactDisplayDestination(ride: DestinationRide): string | undefined {
  const variant = ride.variant?.name && normalizeDestinationName(ride.variant.name);
  if (!variant) return undefined;
  let routeName = ride.route?.name && normalizeDestinationName(ride.route.name).replace(/^route\s+/, '');
  const routeKey = String(ride.route?.key ?? '').toLowerCase();
  const namedPrefix = routeName?.match(/^(\S+)\s+(.*)$/s);
  if (namedPrefix?.[1] === routeKey) routeName = namedPrefix[2];
  const prefix = routeName ? `${routeName} to ` : undefined;
  if (prefix && variant.startsWith(prefix)) return variant.slice(prefix.length) || undefined;
  if (variant.startsWith('to ')) return variant.slice(3).trim() || undefined;
  // A bare destination remains supported. An unrecognized route prefix needs metadata.
  return variant.includes(' to ') ? undefined : variant;
}

export function loadDestinationLookup(path: string): DestinationLookup | undefined {
  try {
    return checkDestinationLookup(JSON.parse(readFileSync(path, 'utf8')));
  } catch {
    return undefined;
  }
}

export function checkDestinationLookup(data: any): DestinationLookup | undefined {
  if (data?.schemaVersion !== 1 || typeof data.generatedAt !== 'string' || !Number.isFinite(Date.parse(data.generatedAt))) return undefined;
  if (typeof data.historySourceSha256 !== 'string' || !data.historySourceSha256) return undefined;
  if (!data.variants || typeof data.variants !== 'object' || Array.isArray(data.variants)) return undefined;
  for (const [key, value] of Object.entries(data.variants)) {
    const entry = value as DestinationEntry;
    if (!entry || typeof entry.route !== 'string' || !entry.route || !key.startsWith(`${entry.route}-`)) return undefined;
    if (typeof entry.destination !== 'string' || !entry.destination || entry.destination !== normalizeDestinationName(entry.destination)) return undefined;
    if (!Array.isArray(entry.displayNames) || !entry.displayNames.length || !entry.displayNames.every(name =>
      typeof name === 'string' && name.length > 0 && name === normalizeDestinationName(name))) return undefined;
    if (!['variant-api', 'exact-display-fallback'].includes(entry.source)) return undefined;
  }
  return data;
}

const lookup = reliabilityStore ? checkDestinationLookup(reliabilityStore.manifest('destinations')) : undefined;

/** Variant IDs select reviewed historical names; display text guards against a reused/stale ID. */
export function resolveDestination(ride: DestinationRide, data: DestinationLookup | null | undefined = lookup): DestinationResolution {
  const route = String(ride.route?.key ?? '');
  const variantKey = ride.variant?.key;
  if (variantKey && !variantKey.startsWith(`${route}-`)) {
    return { status: 'unavailable', reason: 'destination_variant_route_mismatch' };
  }
  const exact = exactDisplayDestination(ride);
  const entry = variantKey && Object.hasOwn(data?.variants ?? {}, variantKey) ? data?.variants[variantKey] : undefined;
  if (entry) {
    if (entry.route !== route) return { status: 'unavailable', reason: 'destination_variant_route_mismatch' };
    const display = ride.variant?.name && normalizeDestinationName(ride.variant.name);
    if (display && !entry.displayNames.includes(display) && exact !== entry.destination) {
      return { status: 'unavailable', reason: 'destination_variant_changed' };
    }
    return { status: 'resolved', destination: entry.destination };
  }
  // Exact fallback still has to find an exact historical group in the normal readers.
  if (exact) return { status: 'resolved', destination: exact };
  return { status: 'unavailable', reason: data ? 'destination_variant_unknown' : 'destination_metadata_missing' };
}

export type VariantNames = {
  route: string;
  routeName?: string;
  key: string;
  displayName: string;
  canonicalName?: string;
};

/** Build only complete, unambiguous entries whose destinations exist in same-route history. */
export function createDestinationLookup(
  records: VariantNames[],
  historical: ReadonlyMap<string, ReadonlySet<string>>,
  historySourceSha256: string,
  generatedAt = new Date().toISOString(),
): DestinationLookup {
  if (!records.length || !historySourceSha256 || !Number.isFinite(Date.parse(generatedAt))) {
    throw new Error('Incomplete destination lookup provenance');
  }
  const variants: DestinationLookup['variants'] = {};
  for (const record of records) {
    if (!record.key.startsWith(`${record.route}-`) || Object.hasOwn(variants, record.key)) {
      throw new Error(`Conflicting variant identity: ${record.key}`);
    }
    const canonical = record.canonicalName && normalizeDestinationName(record.canonicalName);
    const destination = canonical || exactDisplayDestination({
      route: { key: record.route, name: record.routeName }, variant: { name: record.displayName },
    });
    if (!destination || !historical.get(record.route)?.has(destination)) {
      throw new Error(`No exact historical destination for ${record.key}`);
    }
    if (!record.displayName.trim()) throw new Error(`Missing display name for ${record.key}`);
    variants[record.key] = {
      route: record.route,
      destination,
      displayNames: [...new Set([normalizeDestinationName(record.displayName), destination])].sort(),
      source: canonical ? 'variant-api' : 'exact-display-fallback',
    };
  }
  return { schemaVersion: 1, generatedAt, historySourceSha256, variants };
}
