import { score } from '@/lib/pipeline';
import { db } from '@/lib/supabase';

export const maxDuration = 300;

// Re-runs scoring from the stored (redacted) CV text — used by "Retry" on errored cards.
export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const id = Number((await ctx.params).id);
  try {
    await score(id);
    return Response.json({ ok: true });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    await db().from('candidates').update({ status: 'error', error_message: message }).eq('id', id);
    return Response.json({ error: message }, { status: 500 });
  }
}
