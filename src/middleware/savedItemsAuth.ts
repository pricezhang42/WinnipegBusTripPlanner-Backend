import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { MiddlewareHandler } from 'hono';
import { SavedItemsError } from '../savedItems.js';

export type SavedItemsEnv = { Variables: { userId: string; userClient: SupabaseClient } };
export type UserClientFactory = (token: string) => SupabaseClient;

export function createUserClient(token: string): SupabaseClient {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_PUBLISHABLE_KEY;
  if (!url || !key || key.startsWith('sb_secret_')) {
    throw new SavedItemsError(503, 'saved_items_unconfigured', 'Saved items are not configured on this server.');
  }
  // Reject legacy service-role keys too. This is configuration validation, not token verification.
  if (key.split('.').length === 3) {
    try {
      if (JSON.parse(Buffer.from(key.split('.')[1], 'base64url').toString()).role !== 'anon') throw new Error();
    } catch {
      throw new SavedItemsError(503, 'saved_items_unconfigured', 'Use a publishable or legacy anon key for saved items.');
    }
  }
  return createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    db: { retry: false },
    global: {
      headers: { Authorization: `Bearer ${token}` },
      fetch: (input, init) => fetch(input, { ...init, signal: init?.signal ?
        AbortSignal.any([init.signal, AbortSignal.timeout(8000)]) : AbortSignal.timeout(8000) }),
    },
  });
}

export function savedItemsAuth(factory: UserClientFactory = createUserClient): MiddlewareHandler<SavedItemsEnv> {
  return async (c, next) => {
    const match = /^Bearer\s+(\S+)$/i.exec(c.req.header('Authorization') ?? '');
    if (!match || match[1].length > 16384) throw new SavedItemsError(401, 'unauthorized', 'Please sign in to access saved items.');
    const client = factory(match[1]);
    let result;
    try { result = await client.auth.getUser(match[1]); }
    catch { throw new SavedItemsError(503, 'auth_unavailable', 'Authentication is temporarily unavailable.'); }
    if (result.error) {
      const status = result.error.status;
      if (status === 400 || status === 401 || status === 403 || status === 422) {
        throw new SavedItemsError(401, 'unauthorized', 'Please sign in again.');
      }
      throw new SavedItemsError(503, 'auth_unavailable', 'Authentication is temporarily unavailable.');
    }
    if (!result.data.user) throw new SavedItemsError(401, 'unauthorized', 'Please sign in again.');
    c.set('userId', result.data.user.id);
    c.set('userClient', client);
    await next();
  };
}
