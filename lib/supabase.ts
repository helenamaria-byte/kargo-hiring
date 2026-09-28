// Server-only Supabase client. Uses the service-role key, which must never reach the browser:
// nothing in this project imports this file from a 'use client' component.
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { env } from './config';

let client: SupabaseClient | null = null;

export function db(): SupabaseClient {
  client ??= createClient(env('SUPABASE_URL'), env('SUPABASE_SERVICE_ROLE_KEY'), {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return client;
}

// Unwraps { data, error } and throws on error so failures are never silent.
export async function q<T = unknown>(p: PromiseLike<{ data: unknown; error: { message: string } | null }>): Promise<T> {
  const { data, error } = await p;
  if (error) throw new Error(`Database: ${error.message}`);
  return data as T;
}
