// Must match the history builder's manifest; older one-hour or seasonal keys are never read.
export const GROUPING = 'route-stop-destination-daytype-2hour-v1';
export type Sharded<T> = {
  // Inline groups serve tests and small fixtures; deployed data comes from the SQLite store.
  groups: Record<string, T>; routeFiles?: Record<string, string>;
  lookup?: (route: string, key: string) => T | undefined;
};

/** One group by exact key, from the SQLite store when present. */
export function artifactGroup<T>(data: Sharded<T>, route: string, key: string): T | undefined {
  if (data.lookup) return data.lookup(route, key);
  return Object.hasOwn(data.groups, key) ? data.groups[key] : undefined;
}
