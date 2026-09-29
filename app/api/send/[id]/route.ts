import { emailConfigured, emailOverride } from '@/lib/config';
import { firstName } from '@/lib/pii';
import { db, q } from '@/lib/supabase';

// Sends exactly one email, for one candidate, only when Arjun clicks Confirm & Send.
// With { manual: true } (Gmail mode) Arjun already sent it from his own Gmail; this only records it.
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const id = Number((await ctx.params).id);
  const { subject, body, manual } = await req.json();
  if (!manual && !emailConfigured()) {
    return Response.json({ error: 'Email not configured: set RESEND_API_KEY and RESEND_FROM in Vercel, then redeploy.' }, { status: 503 });
  }
  if (typeof subject !== 'string' || !subject.trim() || typeof body !== 'string' || !body.trim()) {
    return Response.json({ error: 'Subject and body are required' }, { status: 400 });
  }

  const [c] = await q<{ id: number; name: string | null; email: string | null; sent_at: string | null; duplicate_of: number | null }[]>(
    db().from('candidates').select('id, name, email, sent_at, duplicate_of').eq('id', id),
  );
  if (!c) return Response.json({ error: 'Candidate not found' }, { status: 404 });
  if (c.sent_at) return Response.json({ error: `Already sent at ${c.sent_at}` }, { status: 409 });
  const override = manual ? null : emailOverride();
  if (!c.email && !override) return Response.json({ error: 'No email address — add one on the card first' }, { status: 400 });
  const first = firstName(c.name);
  if (!first && /\{\{\s*first_name\s*\}\}/.test(subject + body)) {
    return Response.json({ error: 'No name on file to fill {{first_name}} — add the name on the card first' }, { status: 400 });
  }

  // The real name is merged here, at send time, and nowhere earlier.
  const merge = (s: string) => s.replace(/\{\{\s*first_name\s*\}\}/g, first ?? '');
  // Test mode: deliver to the one test inbox, and say at the top who it was really for.
  const text = override ? `[TEST MODE: this email is for ${c.name ?? 'the candidate'} <${c.email ?? 'no email on file'}>]

${merge(body)}` : merge(body);
  const to = override ?? c.email!;
  const finalSubject = override ? `[TEST for ${c.name ?? 'candidate'}] ${merge(subject)}` : merge(subject);

  // Save exactly what is being sent, then claim the send atomically so a double click can't send twice.
  await q(db().from('drafts').update({ email_subject: subject, email_body: body, updated_at: new Date().toISOString() }).eq('candidate_id', id));
  const sentAt = new Date().toISOString();
  const claimed = await q<{ id: number }[]>(
    db().from('candidates').update({ sent_at: sentAt, status: 'sent' }).eq('id', id).is('sent_at', null).select('id'),
  );
  if (!claimed.length) return Response.json({ error: 'Already sent' }, { status: 409 });
  if (manual) return Response.json({ ok: true, sentAt });

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: process.env.RESEND_FROM,
      to: [to],
      subject: finalSubject,
      text,
      ...(process.env.RESEND_REPLY_TO ? { reply_to: process.env.RESEND_REPLY_TO } : {}),
    }),
  });
  if (!res.ok) {
    const detail = await res.text();
    await db().from('candidates').update({ sent_at: null, status: 'ready' }).eq('id', id);
    return Response.json({ error: `Resend rejected the email (${res.status}): ${detail}` }, { status: 502 });
  }
  return Response.json({ ok: true, sentAt, to });
}
