// After you replace a key in .env.local, run: npm run update:keys
// Copies SUPABASE_*, GEMINI_API_KEY, RESEND_*, DASHBOARD_PASSWORD from .env.local to Vercel, checks them, and redeploys.
import { execSync } from 'node:child_process';
import dotenv from 'dotenv';
const env = dotenv.config({ path: '.env.local', quiet: true }).parsed ?? {};
const NAMES = ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'GEMINI_API_KEY', 'GEMINI_MODEL', 'RESEND_API_KEY', 'RESEND_FROM', 'RESEND_REPLY_TO', 'DASHBOARD_PASSWORD'];
execSync('node scripts/check-keys.mjs', { stdio: 'inherit' });
for (const k of NAMES) {
  if (!env[k]) continue;
  execSync(`npx vercel env add ${k} production --force`, { input: env[k], stdio: ['pipe', 'ignore', 'inherit'] });
  console.log(`✔ ${k} saved to Vercel`);
}
execSync('npx vercel deploy --prod --yes', { stdio: ['ignore', 'ignore', 'inherit'] });
console.log('✔ Redeployed https://kargo-hiring-one.vercel.app');
