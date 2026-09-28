// Calls /api/drafts until every ranked candidate has the right brief + email for the current ranking.
export async function runDrafts(progress: (s: string) => void): Promise<string> {
  let done = 0;
  for (let round = 0; round < 100; round++) {
    const res = await fetch('/api/drafts', { method: 'POST' });
    const j = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
    if (!res.ok || j.error) return `Draft generation failed: ${j.error}`;
    done += j.processed;
    if (j.errors?.length) return `${done} drafts written. Some failed (click again to retry): ${j.errors.join(' | ')}`;
    if (j.remaining === 0) return `Drafts up to date (${done} written).`;
    progress(`${done} drafts written, ${j.remaining} to go…`);
  }
  return 'Stopped after 100 rounds; click again to continue.';
}
