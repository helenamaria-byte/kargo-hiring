import type { Role } from './scoring';

export const ROLES: Role[] = ['PM', 'SPM'];
export const ROLE_TITLE: Record<Role, string> = { PM: 'Product Manager', SPM: 'Senior Product Manager' };
export const COMPANY = 'Kargo';
export const FOUNDER = 'Arjun';

export function env(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing environment variable ${name} — add it to .env.local (and to Vercel for the live site).`);
  return v;
}

export const emailConfigured = () => Boolean(process.env.RESEND_API_KEY && process.env.RESEND_FROM);
