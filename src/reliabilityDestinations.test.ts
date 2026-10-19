import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createDestinationLookup, loadDestinationLookup, resolveDestination,
  type DestinationRide,
} from './reliabilityDestinations.js';
import { boardingContext, enrichPlans, reliabilityForRide } from './reliability.js';

const fixtures: Array<DestinationRide & { destination: string }> = JSON.parse(readFileSync(
  new URL('./fixtures/reliability-destination-names.json', import.meta.url), 'utf8'));
const lookup = loadDestinationLookup(new URL('../data/reliability-destinations.json', import.meta.url).pathname)!;
const ride678 = fixtures.find(ride => ride.variant?.key === '678-0-F')!;

test('all 185 audited variants resolve to their same-route canonical historical names', () => {
  assert.ok(lookup);
  assert.equal(fixtures.length, 185);
  assert.equal(Object.keys(lookup.variants).length, 185);
  for (const ride of fixtures) {
    assert.deepEqual(resolveDestination(ride), { status: 'resolved', destination: ride.destination }, ride.variant?.key);
    assert.equal(lookup.variants[ride.variant!.key!].route, String(ride.route?.key));
  }
  // Canonical metadata retains this branch rather than stripping every "via".
  assert.equal(lookup.variants['676-0-C'].destination, 'creek bend via burland');
  assert.equal(lookup.variants['691-1-W'].destination, 'whyte ridge via scurfield');
});

test('changed, unknown and cross-route variants cannot borrow another branch', () => {
  assert.deepEqual(resolveDestination({ ...ride678, variant: { key: '678-0-F', name: 'Waverly West - Chancellor to South Pointe' } }),
    { status: 'unavailable', reason: 'destination_variant_changed' });
  assert.deepEqual(resolveDestination({ ...ride678, route: { key: '679' } }),
    { status: 'unavailable', reason: 'destination_variant_route_mismatch' });
  assert.deepEqual(resolveDestination({ ...ride678, variant: { key: '678-new', name: 'Unrecognized Route to Somewhere via Another Place' } }),
    { status: 'unavailable', reason: 'destination_variant_unknown' });
  // An upstream correction of the route spelling still resolves exactly.
  assert.deepEqual(resolveDestination({ ...ride678, variant: { key: '678-0-F', name: 'Waverley West - Chancellor to Freedman Terminal' } }),
    { status: 'resolved', destination: 'freedman terminal' });
});

test('missing metadata fails safely but established exact-name fallbacks remain usable', () => {
  assert.deepEqual(resolveDestination(ride678, null), { status: 'unavailable', reason: 'destination_metadata_missing' });
  assert.deepEqual(resolveDestination({ route: { key: 'BLUE' }, variant: { key: 'BLUE-1-S', name: 'to St. Norbert' } }, null),
    { status: 'resolved', destination: 'st. norbert' });
  assert.deepEqual(resolveDestination({ route: { key: '676' }, variant: { name: 'Creek Bend via Burland' } }, null),
    { status: 'resolved', destination: 'creek bend via burland' });
  assert.deepEqual(resolveDestination({ ...ride678, variant: { key: '678-0-F' } }),
    { status: 'resolved', destination: 'freedman terminal' });
});

test('lookup loader rejects missing, malformed and cross-route metadata', () => {
  const folder = mkdtempSync(join(tmpdir(), 'destination-names-'));
  try {
    const path = join(folder, 'lookup.json');
    assert.equal(loadDestinationLookup(path), undefined);
    for (const value of [null, { ...lookup, schemaVersion: 2 },
      { ...lookup, variants: { '678-0-F': { ...lookup.variants['678-0-F'], route: '679' } } },
      { ...lookup, variants: { '678-0-F': { ...lookup.variants['678-0-F'], destination: 'Freedman Terminal' } } },
    ]) {
      writeFileSync(path, JSON.stringify(value));
      assert.equal(loadDestinationLookup(path), undefined);
    }
    writeFileSync(path, JSON.stringify(lookup));
    assert.ok(loadDestinationLookup(path));
  } finally { rmSync(folder, { recursive: true, force: true }); }
});

test('refresh builder rejects unsupported destinations and duplicate identities before installation', () => {
  const names = [{ route: '678', routeName: 'Route 678 Waverley West - Chancellor', key: '678-0-F',
    displayName: 'Waverly West - Chancellor to Freedman Terminal', canonicalName: 'Freedman Terminal' }];
  const history = new Map([['678', new Set(['freedman terminal'])]]);
  assert.equal(createDestinationLookup(names, history, 'source').variants['678-0-F'].destination, 'freedman terminal');
  assert.throws(() => createDestinationLookup([...names, ...names], history, 'source'), /Conflicting variant/);
  assert.throws(() => createDestinationLookup(names, new Map(), 'source'), /No exact historical/);
  assert.throws(() => createDestinationLookup([], history, 'source'), /Incomplete/);
  assert.throws(() => createDestinationLookup(names, history, ''), /Incomplete/);
  const fallback = [{ route: 'BLUE', key: 'BLUE-1-S', displayName: 'to St. Norbert' }];
  const built = createDestinationLookup(fallback, new Map([['BLUE', new Set(['st. norbert'])]]), 'source');
  assert.equal(built.variants['BLUE-1-S'].source, 'exact-display-fallback');
});

test('the reproduced 678 ride gets timing; 679 remains sparse and both measures share the destination', () => {
  const previous = { type: 'walk', to: { stop: { key: 60185 } } };
  const ride = { ...ride678, type: 'ride', times: { start: '2026-10-19T17:13:00' } };
  const now = new Date('2026-10-18T18:00:00Z');
  const result = reliabilityForRide(ride, previous, undefined, now);
  assert.equal(result.status, 'available');
  if (result.status !== 'available') return;
  assert.equal(result.observations, 37);
  assert.equal(result.distinctDates, 11);
  assert.equal(Math.round((result.earlyShare + result.lateShare) * 100), 57);
  const other = fixtures.find(ride => ride.variant?.key === '679-1-U')!;
  const ride679 = { ...other, type: 'ride', times: { start: '2026-10-19T17:35:00' } };
  assert.deepEqual(reliabilityForRide(ride679, previous, undefined, now),
    { status: 'unavailable', reason: 'insufficient_comparable_history' });
  assert.equal(boardingContext(ride679, previous)?.destination, 'freedman terminal');
  const enriched = enrichPlans([{ segments: [previous, ride, previous, ride679] }], undefined, now) as Array<{
    segments: Array<{ passupReports?: { status: string; recordedDepartures?: number }; passupRisk?: { basis: string } }>;
  }>;
  assert.equal(enriched[0].segments[1].passupReports?.status, 'available');
  assert.equal(enriched[0].segments[1].passupReports?.recordedDepartures, 37);
  assert.equal(enriched[0].segments[3].passupReports?.recordedDepartures, 2);
  assert.equal(enriched[0].segments[3].passupRisk?.basis, 'insufficient_reference_history');
});

test('metadata failures report an actionable reason without blocking the itinerary', () => {
  const ride = { ...ride678, type: 'ride', from: { stop: { key: 60185 } }, times: { start: '2026-10-19T17:13:00' },
    variant: { key: '678-0-F', name: 'Changed Route to Unknown Branch' } };
  const plans = [{ segments: [ride] }];
  const result = enrichPlans(plans, undefined, new Date('2026-10-18T18:00:00Z')) as any[];
  assert.equal(result.length, 1);
  assert.equal(result[0].segments[0].reliability.reason, 'destination_variant_changed');
  assert.equal(result[0].segments[0].passupRisk.basis, 'destination_variant_changed');
  assert.equal('reliability' in ride, false);
});
