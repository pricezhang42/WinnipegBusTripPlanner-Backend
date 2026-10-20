import { cors } from 'hono/cors';

export function apiCors() {
  const origins = (process.env.CORS_ORIGINS ?? '').split(',').map(value => value.trim()).filter(Boolean);
  return cors({
    origin: origins.length ? origins : '*',
    allowMethods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
    allowHeaders: ['Content-Type', 'Authorization'],
  });
}
