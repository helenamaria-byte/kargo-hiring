import { ingest } from '@/lib/pipeline';
import type { Role } from '@/lib/scoring';

export const maxDuration = 300;

// One CV per request, so one bad file never stops the batch.
export async function POST(req: Request) {
  const form = await req.formData();
  const file = form.get('file');
  const role = form.get('role');
  if (!(file instanceof File)) return Response.json({ error: 'No file' }, { status: 400 });
  if (role !== 'PM' && role !== 'SPM') return Response.json({ error: 'Pick PM or SPM for the batch' }, { status: 400 });
  try {
    return Response.json(await ingest(file, role as Role));
  } catch (e) {
    return Response.json({ status: 'error', error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
