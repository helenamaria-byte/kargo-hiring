import Link from 'next/link';
import { Nav } from '@/components/Nav';
import { loadStats } from '@/lib/review';

export const dynamic = 'force-dynamic';

export default async function Welcome() {
  let stats: Awaited<ReturnType<typeof loadStats>> | null = null;
  let error: string | null = null;
  try { stats = await loadStats(); } catch (e) { error = e instanceof Error ? e.message : String(e); }

  return (
    <>
      <Nav on="home" />
      <main className="page">
        <section className="hero">
          <h1>CV decisions, made simple</h1>
          {stats ? (
            <p className="stats">
              <b>{stats.reviewed}</b> candidates reviewed · <b>{stats.invitesReady}</b> invites ready · <b>{stats.sent}</b> emails sent
            </p>
          ) : (
            <p className="note err">Could not load stats: {error}</p>
          )}
        </section>
        <div className="choices">
          <Link href="/review" className="choice">
            <span className="icon" aria-hidden>
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M4 6h16M4 12h10M4 18h7" /></svg>
            </span>
            <div className="t">Review candidates</div>
            <div className="muted">Ranked shortlists for PM and SPM, with briefs, evidence and draft emails.</div>
          </Link>
          <Link href="/upload" className="choice">
            <span className="icon" aria-hidden>
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M12 16V4M7 9l5-5 5 5M5 20h14" /></svg>
            </span>
            <div className="t">Upload new CVs</div>
            <div className="muted">Drop in PDFs or Word files. Each one is scored on both rubrics.</div>
          </Link>
        </div>
      </main>
    </>
  );
}
