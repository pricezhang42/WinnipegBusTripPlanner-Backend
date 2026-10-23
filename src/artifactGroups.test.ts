import { test } from 'node:test';
import assert from 'node:assert/strict';
import { artifactGroup } from './artifactGroups.js';

test('store lookups take precedence and inline groups serve fixtures', () => {
  const key = '["F8","1","downtown","weekday",12]';
  assert.equal(artifactGroup({ groups: { [key]: 1 } }, 'F8', key), 1);
  assert.equal(artifactGroup({ groups: { [key]: 1 } }, 'F8', 'constructor'), undefined);
  const calls: string[][] = [];
  const lookup = (route: string, requested: string) => { calls.push([route, requested]); return 2; };
  assert.equal(artifactGroup({ groups: { [key]: 1 }, lookup }, 'F8', key), 2);
  assert.deepEqual(calls, [['F8', key]]);
});
