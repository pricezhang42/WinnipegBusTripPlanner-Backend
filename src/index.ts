import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { apiCors } from './middleware/apiCors.js';
import { logger } from 'hono/logger';
import { geocodeRoute } from './routes/geocode.js';
import { plansRoute } from './routes/plans.js';
import { routeShapeRoute } from './routes/routeShape.js';
import { createSavedItemsRoute } from './routes/savedItems.js';
import { startGtfsRefreshLoop } from './gtfs/loader.js';
import { SERVICE_CALENDAR } from './serviceCalendar.js';

const app = new Hono();

// Saved-item URLs contain private coordinate keys; omit them from request logs.
app.use('*', (c, next) => c.req.path.startsWith('/api/me') ? next() : logger()(c, next));

app.use('/api/*', apiCors());

app.get('/', (c) => c.text('BusTripPlanner backend — see /api/*'));
app.get('/healthz', (c) => c.json({ ok: true, uptime: process.uptime(), serviceCalendar: SERVICE_CALENDAR.version }));

app.route('/api/me', createSavedItemsRoute());
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
