import { Nav } from '@/components/Nav';
import { Review } from '@/components/Review';
import { loadReview } from '@/lib/review';
import type { Role } from '@/lib/scoring';

export const dynamic = 'force-dynamic';

export default async function ReviewPage({ searchParams }: { searchParams: Promise<{ role?: string }> }) {
  const role: Role = (await searchParams).role === 'SPM' ? 'SPM' : 'PM';
  let data: Awaited<ReturnType<typeof loadReview>> | null = null;
  let error: string | null = null;
  try { data = await loadReview(role); } catch (e) { error = e instanceof Error ? e.message : String(e); }

  return (
    <>
      <Nav on="review" />
      <main className="page">
        {data?.mode === 'resend' && data.testTo && (
          <div className="banner">Test mode: every email is sent to <b>{data.testTo}</b>, not to candidates.</div>
        )}
        {data?.mode === 'gmail' && <div className="banner">Sending through Gmail: Send opens a ready email in Gmail.</div>}
        <h1>Review candidates</h1>
        {error && <p className="note err">Could not load candidates: {error}</p>}
        {data && <Review role={role} rows={data.rows} threshold={data.threshold} topN={data.topN} mode={data.mode} testTo={data.testTo} />}
      </main>
    </>
  );
}
