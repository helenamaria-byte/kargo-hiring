// Quick live check of each key in .env.local: npm run check:keys
import dotenv from 'dotenv';
import { createClient } from '@supabase/supabase-js';
import { GoogleGenAI } from '@google/genai';
dotenv.config({ path: '.env.local', quiet: true });

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const { data, error } = await sb.from('rubric_criteria').select('role, weight');
console.log(error ? `✖ Supabase: ${error.message}` : `✔ Supabase: read ${data.length} rubric rows`);

const anon = await fetch(`${process.env.SUPABASE_URL}/rest/v1/candidates?select=id`, { headers: { apikey: 'invalid' } });
console.log(`  (public access without the secret key → HTTP ${anon.status}, expected 401)`);

try {
  const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
  const model = process.env.GEMINI_MODEL || 'gemini-flash-latest';
  const r = await ai.models.generateContent({ model, contents: 'Reply with exactly: ok' });
  console.log(`✔ Gemini (${model}): "${r.text?.trim()}" [${r.modelVersion ?? ''}]`);
} catch (e) {
  console.log(`✖ Gemini: ${e.message?.slice(0, 400)}`);
}
