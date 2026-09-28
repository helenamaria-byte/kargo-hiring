import { CandidateCard } from '@/components/CandidateCard';
import { DraftsButton } from '@/components/DraftsButton';
import { Nav } from '@/components/Nav';
import { emailConfigured, ROLE_TITLE } from '@/lib/config';
import { loadDashboard } from '@/lib/dashboard';
import type { Role } from '@/lib/scoring';

export const dynamic = 'force-dynamic';

export default async function Dashboard({ searchParams }: { searchParams: Promise<{ role?: string }> }) {
  const role: Role = (await searchParams).role === 'SPM' ? 'SPM' : 'PM';
  let data: Awaited<ReturnType<typeof loadDashboard>>;
  try {
    data = await loadDashboard(role);
  } catch (e) {
    return (
      <>
        <Nav on={role} />
        <main><p className="err">Could not load the dashboard: {e instanceof Error ? e.message : String(e)}</p></main>
      </>
    );
  }
  const { rankedCards, unranked, pendingDrafts, inProgress, counts } = data;
  const configured = emailConfigured();

  return (
    <>
      <Nav on={role} />
      <main>
        <h1>{ROLE_TITLE[role]}: {rankedCards.length} ranked by {role} score</h1>
        <div className="bar muted">
          <span>Applied: {counts.PM ?? 0} PM · {counts.SPM ?? 0} SPM. Everyone is scored on both rubrics.</span>
          {inProgress > 0 && <span className="flag">{inProgress} still processing</span>}
          <DraftsButton pending={pendingDrafts} />
          {!configured && <span className="pill warn">Email not configured: sending is off until RESEND_API_KEY and RESEND_FROM are set</span>}
        </div>
        {rankedCards.length === 0 && unranked.length === 0 && <p>No candidates yet. <a href="/upload">Upload CVs</a>.</p>}
        {rankedCards.map((c) => (
          <CandidateCard key={c.id} c={c} role={role} emailConfigured={configured} open={c.rank! <= 5} />
        ))}
        {unranked.length > 0 && (
          <>
            <h1 style={{ marginTop: 24 }}>Not ranked ({unranked.length}): duplicates, errors, in progress</h1>
            {unranked.map((c) => <CandidateCard key={c.id} c={c} role={role} emailConfigured={configured} open={false} />)}
          </>
        )}
      </main>
    </>
  );
}
