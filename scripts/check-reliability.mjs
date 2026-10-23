import { parseArgs } from 'node:util';

// Read-only deployment check using the documented Westbrook → Thatcher trip.
const { values } = parseArgs({ options: {
  'base-url': { type: 'string', default: 'http://localhost:8787' },
  // Fail unless the backend serves this store build (its inputSha256 from the lock file).
  'expect-store': { type: 'string' },
  date: { type: 'string', default: new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Winnipeg', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date()) },
  time: { type: 'string', default: '16:40' },
} });

async function getJson(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(25000) });
  if (!response.ok) throw new Error(`HTTP ${response.status} from ${url.pathname}`);
  return await response.json();
}

async function main() {
  const base = new URL(values['base-url']);
  const health = await getJson(new URL('/healthz', base));
  if (health.ok !== true) throw new Error('Backend health check failed');
  if (values['expect-store'] && (health.reliability?.status !== 'ready' || health.reliability.inputSha256 !== values['expect-store'])) {
    throw new Error(`Backend reliability source is ${JSON.stringify(health.reliability)}, not store ${values['expect-store']}`);
  }
  const url = new URL('/api/plans', base);
  for (const [name, value] of Object.entries({
    origin: 'geo/49.89523,-97.134455', destination: 'geo/49.816532,-97.144433',
    date: values.date, time: values.time, mode: 'depart-after',
  })) url.searchParams.set(name, value);
  const data = await getJson(url);
  if (!Array.isArray(data.plans) || !data.plans.length) throw new Error('No sample plans returned');
  const rides = data.plans.flatMap(plan => plan.segments ?? []).filter(segment => segment.type === 'ride');
  if (!rides.length) throw new Error('No sample rides returned');
  for (const ride of rides) {
    const route = String(ride.route?.key ?? '?');
    if (!['available', 'unavailable'].includes(ride.reliability?.status) ||
        !['available', 'unavailable'].includes(ride.passupReports?.status) ||
        !['low', 'medium', 'high', 'unknown'].includes(ride.passupRisk?.level) ||
        ride.passupRisk?.policyVersion !== 'report-scheduled-visit-ratio-v1') {
      throw new Error(`Route ${route}: merged reliability contract missing or incompatible`);
    }
    if (ride.reliability.status === 'unavailable' && typeof ride.reliability.reason !== 'string') {
      throw new Error(`Route ${route}: unavailable timing has no reason`);
    }
    if (ride.passupReports.status === 'unavailable' && typeof ride.passupReports.reason !== 'string') {
      throw new Error(`Route ${route}: unavailable report evidence has no reason`);
    }
  }
  console.log(JSON.stringify({ backend: base.origin, reliability: health.reliability, date: values.date, time: values.time,
    plans: data.plans.length, rides: rides.length,
    timingAvailable: rides.filter(ride => ride.reliability.status === 'available').length,
    reportEvidenceAvailable: rides.filter(ride => ride.passupReports.status === 'available').length,
    unavailableTimingReasons: [...new Set(rides.filter(ride => ride.reliability.status === 'unavailable').map(ride => ride.reliability.reason))],
    result: 'reliability contract present',
  }, null, 2));
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
