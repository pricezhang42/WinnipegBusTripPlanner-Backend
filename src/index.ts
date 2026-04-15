import 'dotenv/config';
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';
import { geocodeRoute } from './routes/geocode.js';
import { plansRoute } from './routes/plans.js';
import { routeShapeRoute } from './routes/routeShape.js';
import { startGtfsRefreshLoop } from './gtfs/loader.js';

const app = new Hono();

app.use('*', logger());

const allowedOrigins = (process.env.CORS_ORIGINS ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

app.use(
  '/api/*',
  cors({
    origin: allowedOrigins.length > 0 ? allowedOrigins : '*',
    allowMethods: ['GET', 'POST', 'OPTIONS'],
    allowHeaders: ['Content-Type'],
  })
);

app.get('/', (c) => c.text('BusTripPlanner backend — see /api/*'));
app.get('/healthz', (c) => c.json({ ok: true, uptime: process.uptime() }));

app.route('/api/geocode', geocodeRoute);
app.route('/api/plans', plansRoute);
app.route('/api/route-shape', routeShapeRoute);

app.onError((err, c) => {
  console.error('[onError]', err);
  return c.json({ error: 'Internal server error', message: err.message }, 500);
});

const port = Number(process.env.PORT ?? 8787);

startGtfsRefreshLoop().catch((err) => {
  console.warn('[gtfs] initial load failed, will retry on schedule:', err?.message ?? err);
});

serve({ fetch: app.fetch, port }, (info) => {
  console.log(`[server] listening on http://localhost:${info.port}`);
});
