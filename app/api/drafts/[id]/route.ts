import { draftEmailOfType } from '@/lib/pipeline';
export const maxDuration = 300;
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

// Writes the other kind of email (invite ↔ rejection) when Arjun picks it in review mode. Never sends.
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const id = Number((await ctx.params).id);
  const { type } = await req.json();
  if (type !== 'invite' && type !== 'rejection') return Response.json({ error: 'type must be invite or rejection' }, { status: 400 });
  try {
    return Response.json(await draftEmailOfType(id, type));
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
