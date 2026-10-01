import { db, q } from '@/lib/supabase';

// Lets Arjun correct the extracted name or email, or make his own call on the candidate.
export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const id = Number((await ctx.params).id);
  const { name, email, decision } = await req.json();
  const patch: Record<string, string | null> = {};
  // Arjun's own call on a candidate: 'invite', 'reject', or null to follow the ranking again.
  if (decision !== undefined) {
    if (decision !== null && decision !== 'invite' && decision !== 'reject') return Response.json({ error: 'decision must be invite, reject or null' }, { status: 400 });
    patch.decision = decision;
  }
  if (typeof name === 'string') patch.name = name.trim() || null;
  if (typeof email === 'string') {
    if (email.trim() && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) return Response.json({ error: 'That email address looks wrong' }, { status: 400 });
    patch.email = email.trim() || null;
  }
  try {
    await q(db().from('candidates').update(patch).eq('id', id));
    return Response.json({ ok: true });
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
