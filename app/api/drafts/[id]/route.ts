import { db, q } from '@/lib/supabase';

// Saves Arjun's edits to a draft email.
export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const id = Number((await ctx.params).id);
  const { subject, body } = await req.json();
  if (typeof subject !== 'string' || typeof body !== 'string') return Response.json({ error: 'subject and body required' }, { status: 400 });
  try {
    await q(db().from('drafts').update({ email_subject: subject, email_body: body, edited: true, updated_at: new Date().toISOString() }).eq('candidate_id', id));
    return Response.json({ ok: true });
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
