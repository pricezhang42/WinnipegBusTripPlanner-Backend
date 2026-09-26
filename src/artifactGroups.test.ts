import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { artifactGroups, GROUPING } from './artifactGroups.js';
import { loadArtifact, reliabilityForRide } from './reliability.js';
import { loadRisk, passupRisk, POLICY_VERSION } from './passupRisk.js';

test('route artifacts support timing and risk without loading other routes', () => {
  const root=mkdtempSync(join(tmpdir(),'transit-artifacts-'));
  try {
    mkdirSync(join(root,'routes'));
    const key='["F8","1","downtown","weekday",12]';
    const stats={observations:120,distinctDates:12,coverageStart:'2025-09-01',coverageEnd:'2026-09-24',medianSeconds:90,p10Seconds:-120,p90Seconds:600,earlyShare:.2,withinShare:.6,lateShare:.2,beforeScheduleShare:.3,shareIntervals:[[.1,.3],[.5,.7],[.1,.3]],nearbyFullBusReports:3};
    writeFileSync(join(root,'routes/F8.json'),JSON.stringify({groups:{[key]:stats}}));
    const manifest={grouping:GROUPING,schemaVersion:2,routes:['F8','F6'],groups:{},routeFiles:{F8:'routes/F8.json',F6:'missing.json'},coverageEnd:'2026-09-24',sources:{departures:{sha256:'bundle'}}};
    writeFileSync(join(root,'timing.json'),JSON.stringify(manifest));
    const data=loadArtifact(join(root,'timing.json'))!;
    const ride={route:{key:'F8'},variant:{name:'Downtown'},from:{stop:{key:'1'}},times:{start:'2026-09-25T13:00:00'}};
    assert.equal(reliabilityForRide(ride,undefined,data,new Date('2026-09-25')).status,'available');
    assert.deepEqual(artifactGroups(data,'F6'),{});
    assert.deepEqual(artifactGroups({...data,routeFiles:{F8:'../outside.json'}},'F8'),{});
    const profiles=Object.fromEntries(['60m_120s','100m_180s','150m_300s'].map(p=>[p,{reportedVisits:3,reportDates:2}]));
    writeFileSync(join(root,'routes/risk-F8.json'),JSON.stringify({groups:{[key]:{level:'medium',recordedVisits:120,distinctDates:12,coverageEnd:'2026-09-24',profiles}}}));
    writeFileSync(join(root,'risk.json'),JSON.stringify({...manifest,policy:{version:POLICY_VERSION},routeFiles:{F8:'routes/risk-F8.json'}}));
    assert.equal(passupRisk(key,'2026-09-24','bundle',loadRisk(join(root,'risk.json'))).level,'medium');
  } finally { rmSync(root,{recursive:true,force:true}); }
});
