import { db, q } from '@/lib/supabase';

// Lets Arjun correct the extracted name or email before sending.
export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const id = Number((await ctx.params).id);
  const { name, email } = await req.json();
  const patch: Record<string, string | null> = {};
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
