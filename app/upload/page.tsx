'use client';
import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { Nav } from '@/components/Nav';
import { runDrafts } from '@/components/runDrafts';

type State = 'queued' | 'uploading' | 'scoring' | 'scored' | 'duplicate' | 'error';
type Item = { file: File; state: State; pct: number; detail?: string };
const CONCURRENCY = 1;
const MAX_BYTES = 4 * 1024 * 1024; // Vercel's request body limit is 4.5 MB
const ACCEPT = /\.(pdf|docx)$/i;

// One CV per request, with real upload progress; scoring time is shown as an animated bar.
function uploadOne(file: File, role: string, onProgress: (pct: number) => void): Promise<{ status: string; id?: number; duplicateOf?: number; error?: string }> {
  return new Promise((resolve) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/process');
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(Math.round((e.loaded / e.total) * 100));
    xhr.onload = () => { try { resolve(JSON.parse(xhr.responseText)); } catch { resolve({ status: 'error', error: `HTTP ${xhr.status}` }); } };
    xhr.onerror = () => resolve({ status: 'error', error: 'Network error' });
    const fd = new FormData();
    fd.append('file', file);
    fd.append('role', role);
    xhr.send(fd);
  });
}

export default function Upload() {
  const [role, setRole] = useState<'PM' | 'SPM'>('PM');
  const [items, setItems] = useState<Item[]>([]);
  const [phase, setPhase] = useState<'idle' | 'scoring' | 'drafting' | 'done'>('idle');
  const [over, setOver] = useState(false);
  const [draftMsg, setDraftMsg] = useState('');
  const input = useRef<HTMLInputElement>(null);
  const running = phase === 'scoring' || phase === 'drafting';

  useEffect(() => {
    if (!running) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [running]);

  const add = (files: FileList | File[]) => {
    const list = [...files].filter((f) => ACCEPT.test(f.name));
    if (!list.length) return;
    setItems((xs) => [...(phase === 'done' ? [] : xs), ...list.map((file) => ({ file, state: 'queued' as State, pct: 0 }))]);
    if (phase === 'done') { setPhase('idle'); setDraftMsg(''); }
  };
  const update = (i: number, p: Partial<Item>) => setItems((xs) => xs.map((x, j) => (j === i ? { ...x, ...p } : x)));

  async function start() {
    setPhase('scoring');
    let next = 0;
    const snapshot = items;
    const worker = async () => {
      while (next < snapshot.length) {
        const i = next++;
        if (snapshot[i].state !== 'queued') continue;
        const { file } = snapshot[i];
        if (file.size > MAX_BYTES) { update(i, { state: 'error', pct: 100, detail: 'Over 4 MB: too large' }); continue; }
        update(i, { state: 'uploading', pct: 0 });
        const j = await uploadOne(file, role, (pct) => update(i, { pct: Math.min(pct, 99), state: pct >= 100 ? 'scoring' : 'uploading' }));
        if (j.status === 'scored') update(i, { state: 'scored', pct: 100, detail: 'Scored' });
        else if (j.status === 'duplicate') update(i, { state: 'duplicate', pct: 100, detail: `Duplicate of #${j.duplicateOf}` });
        else update(i, { state: 'error', pct: 100, detail: j.error ?? 'Failed' });
      }
    };
    await Promise.all(Array.from({ length: CONCURRENCY }, worker));
    setPhase('drafting');
    setDraftMsg(await runDrafts(setDraftMsg));
    setPhase('done');
  }

  const count = (s: State) => items.filter((x) => x.state === s).length;
  const finished = count('scored') + count('duplicate') + count('error');

  return (
    <>
      <Nav on="upload" />
      <main className="page">
        <h1>Upload new CVs</h1>
        <p className="muted">PDF or Word. Each CV is scored on both rubrics; names, emails and phone numbers are removed before any AI step.</p>

        <div style={{ display: 'flex', alignItems: 'center', gap: 14, marginTop: 28 }}>
          <span className="small muted">These CVs are for</span>
          <div className="seg" role="radiogroup">
            {(['PM', 'SPM'] as const).map((r) => (
              <button key={r} role="radio" aria-checked={role === r} className={role === r ? 'on' : ''} disabled={running} onClick={() => setRole(r)}>
                {r === 'PM' ? 'Product Manager' : 'Senior Product Manager'}
              </button>
            ))}
          </div>
        </div>

        <div
          className={`drop${over ? ' over' : ''}`}
          onClick={() => !running && input.current?.click()}
          onDragOver={(e) => { e.preventDefault(); setOver(true); }}
          onDragLeave={() => setOver(false)}
          onDrop={(e) => { e.preventDefault(); setOver(false); if (!running) add(e.dataTransfer.files); }}
        >
          <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" strokeWidth="2" strokeLinecap="round"><path d="M12 16V4M7 9l5-5 5 5M5 20h14" /></svg>
          <div className="t">Drop CVs here</div>
          <div className="muted small">or click to choose files</div>
          <input ref={input} type="file" multiple hidden accept=".pdf,.docx" onChange={(e) => { if (e.target.files) add(e.target.files); e.target.value = ''; }} />
        </div>

        {items.length > 0 && (
          <>
            <div className="toolbar" style={{ marginBottom: 8 }}>
              <span className="small"><b>{finished}</b> of {items.length} done</span>
              <span className="small" style={{ color: 'var(--ready)' }}>{count('scored')} scored</span>
              {count('duplicate') > 0 && <span className="small" style={{ color: 'var(--check)' }}>{count('duplicate')} duplicate</span>}
              {count('error') > 0 && <span className="small" style={{ color: 'var(--error)' }}>{count('error')} failed</span>}
              <span className="sp" />
              {phase === 'idle' && <button className="btn primary" onClick={start}>Score {count('queued')} CV{count('queued') === 1 ? '' : 's'}</button>}
              {phase === 'drafting' && <span className="small muted">Writing briefs and emails… {draftMsg}</span>}
              {phase === 'done' && <Link className="btn primary" href={`/review?role=${role}`} style={{ textDecoration: 'none' }}>View rankings</Link>}
            </div>
            {phase === 'done' && draftMsg && <p className="small muted">{draftMsg}</p>}
            <div className="files">
              {items.map((x, i) => (
                <div className="file" key={i}>
                  <span className="fn">{x.file.name}</span>
                  <span className={`prog ${x.state === 'scoring' ? 'busy' : x.state === 'scored' ? 'done' : x.state === 'duplicate' ? 'dup' : x.state === 'error' ? 'fail' : ''}`}>
                    <i style={{ width: `${x.state === 'queued' ? 0 : x.pct}%` }} />
                  </span>
                  <span className="res" style={{ color: x.state === 'error' ? 'var(--error)' : x.state === 'duplicate' ? 'var(--check)' : x.state === 'scored' ? 'var(--ready)' : 'var(--ink-3)' }}>
                    {x.state === 'queued' ? 'Waiting' : x.state === 'uploading' ? `Uploading ${x.pct}%` : x.state === 'scoring' ? 'Scoring…' : x.detail}
                  </span>
                </div>
              ))}
            </div>
          </>
        )}
      </main>
    </>
  );
}
