import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { selection, localSettings, publicSupabase, cleanEnvironment } from './connections.mjs';
const qa1 = 'abcdefghijklmnopqrst', qa2 = 'tsrqponmlkjihgfedcba';
const key = 'sb_publishable_test';
const base = ref => `https://${ref}.supabase.co`;

test('selectors reject duplicate, missing or invalid profile names', () => {
  for (const args of [['--api'], ['--api','../qa'], ['--api','qa1','--api','qa2']]) {
    assert.throws(() => selection(args, ['api']));
  }
  assert.deepEqual(selection(['--api','qa1','--clear'], ['api']), { selected: { api:'qa1' }, rest:['--clear'] });
});
test('profile files are parsed as data and process environment wins', async () => {
  const root = await mkdtemp(join(tmpdir(), 'connections-'));
  try {
    await writeFile(join(root, '.env.connections.local'), 'QA1_API_URL="https://file.example"\nLITERAL="$(touch not-executed)"\n');
    const result = await localSettings(pathToFileURL(root + '/'), { QA1_API_URL:'https://process.example' });
    assert.equal(result.QA1_API_URL, 'https://process.example');
    assert.equal(result.LITERAL, '$(touch not-executed)');
  } finally { await rm(root, { recursive:true }); }
});
test('public Supabase selection rejects secret keys and mismatched legacy projects', () => {
  assert.equal(publicSupabase(base(qa1), key).ref, qa1);
  const jwt = claims => `header.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.signature`;
  assert.equal(publicSupabase(base(qa1), jwt({role:'anon',ref:qa1})).ref, qa1);
  for (const val of ['sb_secret_forbidden', jwt({role:'service_role',ref:qa1}), jwt({role:'anon',ref:qa2}), 'garbage']) {
    assert.throws(() => publicSupabase(base(qa1), val));
  }
});
test('child environment removes operator secrets and unselected connection blocks', () => {
  const dirty = { PATH:'/usr/bin', QA1_DATABASE_URL:'secret', QA2_SUPABASE_ADMIN_KEY:'secret',
    SUPABASE_ACCESS_TOKEN:'secret', FLY_API_TOKEN:'secret', QA1_WT_API_KEY:'secret',
    QA2_MAPBOX_TOKEN:'secret', PRODUCTION_SUPABASE_PUBLISHABLE_KEY:'other',
    EXPO_PUBLIC_BACKEND_URL:'https://old.example', QA1_FLY_APP:'old', QA2_PORT:'9999',
    QA1_RELIABILITY_DATA_PATH:'/private/data', SAVED_ITEMS_TEST_TOKEN_A:'private' };
  assert.deepEqual(cleanEnvironment(dirty), { PATH:'/usr/bin' });
});

import { backendPlan } from './run.mjs';
const settings = { LOCAL_PORT:'18787', LOCAL_API_URL:'http://localhost:18787',
  QA1_FLY_APP:'qa-server', QA1_PORT:'8787', QA1_CORS_ORIGINS:'https://qa.example',
  PRODUCTION_SUPABASE_URL:base(qa1), PRODUCTION_SUPABASE_PUBLISHABLE_KEY:key,
  QA2_SUPABASE_URL:base(qa2), QA2_SUPABASE_PUBLISHABLE_KEY:key, WT_API_KEY:'shared-transit-key',
  MAPBOX_TOKEN:'shared-geocode-token', QA1_WT_API_KEY:'server-override', QA2_DATABASE_URL:'private' };
const registry = { production:{kind:'production',projectRef:qa1}, qa2:{kind:'qa',projectRef:qa2} };
test('server/deployment target is independent from database project', () => {
  const plan = backendPlan(['deploy','--server','qa1','--database','production','--print'],settings,
    {PATH:'/usr/bin', PRODUCTION_DATABASE_URL:'private', SUPABASE_ACCESS_TOKEN:'private'},registry);
  assert.equal(plan.flyApp,'qa-server');
  assert.equal(plan.runtime.SUPABASE_URL,base(qa1));
  assert.equal(plan.runtime.WT_API_KEY,'server-override');
  assert.equal(plan.runtime.MAPBOX_TOKEN,'shared-geocode-token');
  assert.equal(plan.runtime.PORT,'8787');
  assert.equal(plan.env.PRODUCTION_DATABASE_URL,undefined);
  assert.equal(JSON.stringify(plan.summary).includes(key),false);
  assert.equal(plan.print,true);
});
test('missing profiles, incomplete selectors and mismatched registry never fall back', () => {
  for (const args of [['dev','--server','local'], ['deploy'], ['dev','--server','typo','--database','qa2'],
    ['dev','--server','local','--database','qa1'], ['start','--server','local','--database','qa2','--oops']]) {
    assert.throws(() => backendPlan(args, settings, {}, registry));
  }
  assert.throws(() => backendPlan(['dev','--server','local','--database','qa2'],settings,{},
    {production:registry.production,qa2:{kind:'qa',projectRef:qa1}}));
  assert.equal(backendPlan(['dev','--server','local','--database','qa2'], settings,{},registry).runtime.PORT,'18787');
});

test('deployment stages only selected runtime values over stdin and stops if staging fails', async () => {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const { chmod, readFile } = await import('node:fs/promises');
  const dir = await mkdtemp(join(tmpdir(), 'fake-fly-'));
  const log = join(dir,'calls.jsonl');
  const launch = promisify(execFile);
  try {
    const fake = join(dir,'fly');
    await writeFile(fake, `#!/usr/bin/env node
const fs=require('node:fs');
const args=process.argv.slice(2);
const input=args[0]==='secrets'?fs.readFileSync(0,'utf8'):'';
fs.appendFileSync(process.env.FAKE_FLY_LOG,JSON.stringify({args,input,operatorKeys:Object.keys(process.env).filter(k=>/DATABASE_URL|ADMIN_KEY|SUPABASE_ACCESS_TOKEN/.test(k))})+'\\n');
if(args[0]==='secrets'&&process.env.FAKE_FLY_FAIL==='1')process.exit(1);
`);
    await chmod(fake,0o700);
    const env = {...process.env,PATH:dir+':'+process.env.PATH,FAKE_FLY_LOG:log,
      FIXTURE_FLY_APP:'fixture-app',FIXTURE_PORT:'8787',
      QA1_SUPABASE_URL:'https://dvxkygiqnvvghkmqxhvk.supabase.co',QA1_SUPABASE_PUBLISHABLE_KEY:'sb_publishable_fixture',
      WT_API_KEY:'fixture-transit',MAPBOX_TOKEN:'fixture-geocoder',QA2_SUPABASE_ADMIN_KEY:'private-admin',
      PRODUCTION_DATABASE_URL:'private-database',SUPABASE_ACCESS_TOKEN:'private-management'};
    const args = ['scripts/run.mjs','deploy','--server','fixture','--database','qa1'];
    await launch(process.execPath,args,{cwd:new URL('../',import.meta.url),env});
    let calls = (await readFile(log,'utf8')).trim().split('\n').map(JSON.parse);
    assert.deepEqual(calls.map(c=>c.args),[
      ['secrets','import','--stage','--app','fixture-app'],['deploy','--app','fixture-app']]);
    assert.ok(calls[0].input.includes('SUPABASE_PUBLISHABLE_KEY="sb_publishable_fixture"'));
    assert.ok(calls[0].input.includes('WT_API_KEY="fixture-transit"'));
    assert.ok(!calls[0].input.includes('private-'));
    assert.ok(calls.every(c=>c.operatorKeys.length===0));
    await writeFile(log,'');
    await assert.rejects(()=>launch(process.execPath,args,{cwd:new URL('../',import.meta.url),env:{...env,FAKE_FLY_FAIL:'1'}}));
    calls=(await readFile(log,'utf8')).trim().split('\n').map(JSON.parse);
    assert.equal(calls.length,1);
  } finally { await rm(dir,{recursive:true}); }
});
