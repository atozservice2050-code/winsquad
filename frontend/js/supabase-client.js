/* ============================================================
   Supabase client singleton.
   Reads window.__WINSQUAD_ENV__ (set by js/env.js).
   If credentials are missing/placeholder, ENV_OK is false and
   supabase stays null — app.js shows the setup screen instead.
   ============================================================ */
/* supabase-js is loaded via classic script tag (js/supabase-js.js) in HTML.
   Use the global window.supabase.createClient. */
const createClient = (typeof window !== 'undefined' && window.supabase && window.supabase.createClient)
  || (() => { throw new Error('Supabase JS not loaded'); });

const env = (typeof window !== 'undefined' && window.__WINSQUAD_ENV__) || {};
// Fallback defaults (public values) if js/env.js is missing — e.g. when the
// Pages build command hasn't generated it yet. The anon key is public by design.
const FALLBACK_URL = 'https://kzjkvhtakwohxxuysuto.supabase.co';
const FALLBACK_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imt6amt2aHRha3dvaHh4dXlzdXRvIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTE3MzUxNTgsImV4cCI6MjEwNzMxMTE1OH0.uPzzMNKm0FaqjDwZ_0iMotS2rGXx0J9lBNqYXm7G02I';
const url = (env.SUPABASE_URL || '').trim() || FALLBACK_URL;
const key = (env.SUPABASE_ANON_KEY || '').trim() || FALLBACK_KEY;

function looksPlaceholder(v) {
  return !v || /YOUR_|PLACEHOLDER|example/i.test(v);
}

export const ENV_OK = !looksPlaceholder(url) && !looksPlaceholder(key);
export const ENV_ERROR = ENV_OK
  ? null
  : 'Missing Supabase credentials: js/env.js has placeholder values.';

export const supabase = ENV_OK ? createClient(url, key) : null;

/** Unwrap an RPC result: { data, error } -> row object (handles array-or-object). */
export function unwrapRow(data) {
  if (data == null) return null;
  return Array.isArray(data) ? (data[0] ?? null) : data;
}

/** Friendly message for RPC/backend errors. Never leaks raw SQL. */
export function friendlyError(err, fallback = 'Something went wrong. Please try again.') {
  if (!err) return null;
  const msg = String(err.message || err.error || err);
  if (/insufficient|balance/i.test(msg)) return 'Insufficient balance.';
  if (/already|duplicate/i.test(msg)) return 'You already did this. Please check and try again.';
  if (/expired|invalid.*otp|token/i.test(msg)) return 'That code is wrong or expired. Try resending it.';
  if (/rate|too many/i.test(msg)) return 'Too many attempts. Wait a minute and try again.';
  if (/network|fetch|Failed to fetch/i.test(msg)) return 'Network problem. Check your connection.';
  return msg.length < 140 ? msg : fallback;
}
