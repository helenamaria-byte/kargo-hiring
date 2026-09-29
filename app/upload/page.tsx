'use client';
import { useEffect, useState } from 'react';
import { Nav } from '@/components/Nav';
import { runDrafts } from '@/components/runDrafts';

type Row = { file: File; state: 'queued' | 'processing' | 'scored' | 'duplicate' | 'error'; detail?: string };
const CONCURRENCY = 2;
const MAX_BYTES = 4 * 1024 * 1024; // Vercel's request body limit is 4.5 MB

export default function Upload() {
  const [role, setRole] = useState<'' | 'PM' | 'SPM'>('');
  const [rows, setRows] = useState<Row[]>([]);
  const [phase, setPhase] = useState<'idle' | 'scoring' | 'drafting' | 'done'>('idle');
  const [draftMsg, setDraftMsg] = useState('');
  const running = phase === 'scoring' || phase === 'drafting';

  useEffect(() => {
    if (!running) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [running]);

  const update = (i: number, patch: Partial<Row>) => setRows((rs) => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)));

  async function start() {
    setPhase('scoring');
    let next = 0;
    const worker = async () => {
      while (next < rows.length) {
        const i = next++;
        const { file } = rows[i];
        if (file.size > MAX_BYTES) { update(i, { state: 'error', detail: 'File is over 4 MB, too large to upload' }); continue; }
        update(i, { state: 'processing' });
        try {
          const fd = new FormData();
          fd.append('file', file);
          fd.append('role', role);
          const res = await fetch('/api/process', { method: 'POST', body: fd });
          const j = await res.json().catch(() => ({ status: 'error', error: `HTTP ${res.status}` }));
          if (j.status === 'scored') update(i, { state: 'scored', detail: `candidate #${j.id}` });
          else if (j.status === 'duplicate') update(i, { state: 'duplicate', detail: `duplicate of candidate #${j.duplicateOf}, not scored again` });
          else update(i, { state: 'error', detail: j.error ?? 'Unknown error' });
        } catch (e) {
          update(i, { state: 'error', detail: e instanceof Error ? e.message : String(e) });
        }
      }
    };
    await Promise.all(Array.from({ length: CONCURRENCY }, worker));
    setPhase('drafting');
    setDraftMsg(await runDrafts(setDraftMsg));
    setPhase('done');
  }

  const count = (s: Row['state']) => rows.filter((r) => r.state === s).length;
  const finished = rows.length - count('queued') - count('processing');

  return (
    <>
      <Nav on="upload" />
      <main>
        <h1>Upload CVs</h1>
        <div className="bar">
          <strong>Role for this batch:</strong>
          {(['PM', 'SPM'] as const).map((r) => (
            <label key={r} style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
              <input type="radio" name="role" style={{ width: 'auto' }} checked={role === r} disabled={running} onChange={() => setRole(r)} />
              {r === 'PM' ? 'Product Manager' : 'Senior Product Manager'}
            </label>
          ))}
        </div>
        <div className="bar">
          <input
            type="file" multiple accept=".pdf,.docx,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
            disabled={running} style={{ maxWidth: 420 }}
            onChange={(e) => { setRows([...(e.target.files ?? [])].map((file) => ({ file, state: 'queued' }))); setPhase('idle'); setDraftMsg(''); }}
          />
          <button className="primary" disabled={!role || !rows.length || running || phase === 'done'} onClick={start}>
            Process {rows.length || ''} CV{rows.length === 1 ? '' : 's'}
          </button>
        </div>
        <p className="muted">
          PDF or DOCX. Each CV is its own job: one failure never stops the batch. Every CV is scored on both the PM and SPM rubrics.
          Name, email and phone are removed in code before any AI step. Drafts are generated after the whole batch is scored, because the top 5 depends on the full ranking.
        </p>

        {rows.length > 0 && (
          <>
            <div className="bar">
              <strong>{finished}/{rows.length} processed</strong>
              <span className="ok">{count('scored')} scored</span>
              <span className="flag">{count('duplicate')} duplicates</span>
              <span className="err">{count('error')} errors</span>
              {phase === 'drafting' && <span>Writing briefs and emails… {draftMsg}</span>}
              {phase === 'done' && <span>{draftMsg} <a href={`/?role=${role}`}>Open the dashboard →</a></span>}
            </div>
            <progress max={rows.length} value={finished} style={{ width: '100%' }} />
            <table>
              <tbody>
                {rows.map((r, i) => (
                  <tr key={i}>
                    <td>{r.file.name}</td>
                    <td className={r.state === 'error' ? 'err' : r.state === 'duplicate' ? 'flag' : r.state === 'scored' ? 'ok' : 'muted'}>{r.state}</td>
                    <td className="muted">{r.detail}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}
      </main>
    </>
  );
}
