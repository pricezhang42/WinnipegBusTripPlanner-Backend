import type { SupabaseClient } from '@supabase/supabase-js';

export type Location = { id: string; place_name: string; geometry: { coordinates: [number, number] } };
export type Trip = { origin: Location; destination: Location };

export class SavedItemsError extends Error {
  constructor(public status: 400 | 401 | 413 | 503, public code: string, message: string) {
    super(message);
  }
}

function object(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

export function parseLocation(value: unknown): Location {
  if (!object(value) || typeof value.id !== 'string' || !value.id.trim() || value.id.length > 512 ||
      typeof value.place_name !== 'string' || !value.place_name.trim() || value.place_name.length > 2048 ||
      !object(value.geometry) || !Array.isArray(value.geometry.coordinates)) {
    throw new SavedItemsError(400, 'invalid_location', 'A location needs an ID, name, and longitude/latitude coordinates.');
  }
  const coordinates = value.geometry.coordinates;
  if (coordinates.length !== 2 || !coordinates.every(v => typeof v === 'number' && Number.isFinite(v)) ||
      Math.abs(coordinates[0]) > 180 || Math.abs(coordinates[1]) > 90) {
    throw new SavedItemsError(400, 'invalid_location', 'Location coordinates are invalid.');
  }
  // Retain the public location shape, not arbitrary fields from a geocoder response.
  return { id: value.id, place_name: value.place_name, geometry: { coordinates: [coordinates[0], coordinates[1]] } };
}

export function parsePayload(value: unknown, kind: 'location'): { location: Location };
export function parsePayload(value: unknown, kind: 'trip'): Trip;
export function parsePayload(value: unknown, kind: 'location' | 'trip') {
  const allowed = kind === 'location' ? ['location'] : ['origin', 'destination'];
  if (!object(value) || Object.keys(value).some(key => !allowed.includes(key))) {
    throw new SavedItemsError(400, 'invalid_payload', 'Unexpected saved-item fields.');
  }
  return kind === 'location' ? { location: parseLocation(value.location) } :
    { origin: parseLocation(value.origin), destination: parseLocation(value.destination) };
}

// Keep existing exact-coordinate favorite keys. History rounding stays in the SQL function.
export const locationKey = (location: Location) => location.geometry.coordinates.join(',');
export const tripKey = (trip: Trip) => `${locationKey(trip.origin)}>${locationKey(trip.destination)}`;

function checked<T>(result: { data: T; error: { code?: string } | null }): T {
  if (result.error) {
    if (result.error.code === 'PGRST301' || result.error.code === 'PGRST303') {
      throw new SavedItemsError(401, 'unauthorized', 'Please sign in again.');
    }
    throw new SavedItemsError(503, 'saved_items_unavailable', 'Saved items are temporarily unavailable. Please try again.');
  }
  return result.data;
}

export function savedItemsStore(client: SupabaseClient, userId: string) {
  return {
    async list() {
      const results = await Promise.all([
        client.from('favorite_locations').select('location').eq('user_id', userId).order('created_at', { ascending: false }),
        client.from('favorite_trips').select('trip_key,origin,destination,created_at').eq('user_id', userId).order('created_at', { ascending: false }),
        client.from('trip_history').select('id,trip_key,origin,destination,created_at').eq('user_id', userId)
          .order('created_at', { ascending: false }).order('id', { ascending: false }).limit(10),
      ]);
      const locations = checked(results[0]) ?? [];
      const favorites = checked(results[1]) ?? [];
      const history = checked(results[2]) ?? [];
      return { locations: locations.map(row => row.location), favorites, history };
    },
    async saveLocation(location: Location) {
      checked(await client.from('favorite_locations').upsert({ user_id: userId, location_key: locationKey(location), location },
        { onConflict: 'user_id,location_key' }));
    },
    async saveTrip(trip: Trip) {
      checked(await client.from('favorite_trips').upsert({ user_id: userId, trip_key: tripKey(trip), ...trip },
        { onConflict: 'user_id,trip_key' }));
    },
    async recordTrip(trip: Trip) {
      // This SECURITY DEFINER function derives ownership from auth.uid(), locks per user,
      // upserts the rounded trip identity and trims history in one transaction.
      checked(await client.rpc('record_planned_trip', { p_origin: trip.origin, p_destination: trip.destination }));
    },
    async remove(kind: 'location' | 'trip' | 'history', key: string) {
      const [table, column] = kind === 'location' ? ['favorite_locations', 'location_key'] :
        kind === 'trip' ? ['favorite_trips', 'trip_key'] : ['trip_history', 'id'];
      checked(await client.from(table).delete().eq('user_id', userId).eq(column, key));
    },
  };
}
