import { generateDrafts } from '@/lib/pipeline';

export const maxDuration = 300;

// Generates a few drafts per call; the client calls again until remaining is 0.
export async function POST() {
  try {
    return Response.json(await generateDrafts(2));
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
