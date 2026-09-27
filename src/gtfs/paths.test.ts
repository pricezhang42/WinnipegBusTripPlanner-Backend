import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Coord, GtfsIndex } from './loader.js';
import { attachPaths, pathBetweenStops, stopPositions } from './paths.js';
import { stopListsByShape } from './loader.js';

// A straight east-west street: one point every ~70 m; stops A, B, C sit on points 0, 4 and 8.
const street = (n: number): Coord[] => Array.from({ length: n }, (_, i) => ({ lat: 49.9, lng: -97.2 + i * 0.001 }));
const east = street(10);
const west = [...east].reverse();
function index(): GtfsIndex {
  const stopCoords = new Map<string, Coord>([['A', east[0]], ['B', east[4]], ['C', east[8]]]);
  return {
    shapesByRoute: new Map([['R', [{ id: 'west', points: west }, { id: 'east', points: east }]]]),
    stopsByShape: new Map([['east', ['A', 'B', 'C']], ['west', ['C', 'B', 'A']]]),
    stopCoords,
    loadedAt: 0,
  };
}

test('picks the shape that serves both stops in travel order and cuts between them', () => {
  assert.deepEqual(pathBetweenStops(index(), 'R', 'A', 'B'), east.slice(0, 5));
  assert.deepEqual(pathBetweenStops(index(), 'R', 'C', 'B'), west.slice(1, 6));
  assert.equal(pathBetweenStops(index(), 'R', 'A', 'X'), null);
  assert.equal(pathBetweenStops(index(), 'other', 'A', 'B'), null);
  // Two stops on the same line point still get a (straight) path between the stops.
  const close = index(); close.stopCoords.set('B', east[0]);
  assert.deepEqual(pathBetweenStops(close, 'R', 'A', 'B'), [east[0], east[0]]);
});

test('a loop passing the same stop twice resolves each stop to the right pass', () => {
  // Out along the street and back along the same points.
  const loop = [...east, ...west.slice(1)];
  const stops = [east[0], east[8], east[2]];
  assert.deepEqual(stopPositions(loop, stops), [0, 8, 16]);
});

test('stop_times scan keeps one ordered stop list per shape', () => {
  const text = '﻿trip_id,arrival_time,departure_time,stop_id,stop_sequence\r\n1,10:00:00,10:00:00,B,2\r\n1,09:59:00,09:59:00,A,1\r\n2,10:00:00,10:00:00,Z,1\r\n';
  assert.deepEqual([...stopListsByShape(text, new Map([['1', 'east']]))], [['east', ['A', 'B']]]);
});

test('each ride gets its own path, including rides joined by a transfer', () => {
  const plan = { segments: [
    { type: 'walk', to: { stop: { key: 'A' } } },
    { type: 'ride', route: { key: 'R' } },
    { type: 'transfer', from: { stop: { key: 'B' } }, to: { stop: { key: 'B' } } },
    { type: 'ride', route: { key: 'R' } },
    { type: 'walk', from: { stop: { key: 'C' } } },
  ] };
  const [out] = attachPaths([plan], index()) as Array<{ segments: Array<{ path?: number[][] }> }>;
  assert.equal(out.segments[1].path?.length, 5);
  assert.deepEqual(out.segments[1].path?.[0], [49.9, -97.2]);
  assert.equal(out.segments[3].path?.length, 5);
  assert.deepEqual(out.segments[3].path?.at(-1), [49.9, -97.192]);
  assert.equal('path' in out.segments[0], false);
  // No index or an unmatched stop leaves the plan usable, without a path.
  assert.equal(attachPaths([plan], null)[0], plan);
  const unmatched = attachPaths([{ segments: [{ type: 'walk', to: { stop: { key: 'X' } } }, ...plan.segments.slice(1)] }], index()) as any[];
  assert.equal('path' in unmatched[0].segments[1], false);
});
