'use client';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { EmailMode } from '@/lib/config';
import type { Group, Row, Status } from '@/lib/review';
import type { Role } from '@/lib/scoring';
import { runDrafts } from './runDrafts';

type Props = { role: Role; rows: Row[]; threshold: number; topN: number; mode: EmailMode; testTo: string | null };
type Draft = { type: 'invite' | 'rejection' | null; subject: string; body: string };

const STATUS_LABEL: Record<Status, string> = { ready: 'Ready', sent: 'Sent', check: 'Needs checking', processing: 'Processing', error: 'Error' };
const GROUPS: { key: Group; title: string; hint: string }[] = [
  { key: 'invite', title: 'Invite', hint: 'Top 5 at or above the threshold' },
  { key: 'eye', title: 'Needs your eye', hint: 'Strong outsiders and anything flagged' },
  { key: 'no', title: 'Not moving forward', hint: 'Rejection drafted' },
];
const INFO_FLAGS = new Set(['role_assigned']);
const FLAG_LABEL: Record<string, string> = {
  strong_outsider: 'Strong outsider', prompt_injection: 'Text addressed to AI', scores_inconsistent: 'Scores inconsistent',
  thin_evidence: 'Thin evidence', tied_cutoff: 'Tied at cut-off', other_role: 'Fits other role', duplicate: 'Duplicate',
  name_not_detected: 'Name not found', email_not_detected: 'Email not found', name_from_file: 'Name from file name', role_assigned: 'Role assigned by score',
};
// Flag details sometimes start with their own label ("Scores inconsistent: …"); don't show it twice.
const stripLabel = (detail: string, label?: string) =>
  label && detail.toLowerCase().startsWith(label.toLowerCase()) ? detail.slice(label.length).replace(/^\s*(—\s*review\s*)?[:—–-]?\s*/i, '') : detail;
const fmt = (iso: string) => new Date(iso).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
const firstName = (n: string) => n.trim().split(/\s+/)[0] ?? '';
const merge = (t: string, name: string) => t.replace(/\{\{\s*first_name\s*\}\}/g, firstName(name));
const gmailUrl = (to: string, su: string, body: string) =>
  `https://mail.google.com/mail/?view=cm&fs=1&to=${encodeURIComponent(to)}&su=${encodeURIComponent(su)}&body=${encodeURIComponent(body)}`;

async function api(url: string, method: string, body?: unknown) {
  const res = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(j.error ?? `HTTP ${res.status}`);
  return j;
}

export function Review({ role, rows: initial, threshold, topN, mode, testTo }: Props) {
  const router = useRouter();
  const [rows, setRows] = useState(initial);
  const [selected, setSelected] = useState<number | null>(null);
  const [focus, setFocus] = useState(false);
  const [draftMsg, setDraftMsg] = useState('');
  const [drafting, setDrafting] = useState(false);
  useEffect(() => setRows(initial), [initial]);

  const patch = useCallback((id: number, p: Partial<Row>) => setRows((rs) => rs.map((r) => (r.id === id ? { ...r, ...p } : r))), []);
  const byGroup = useMemo(() => Object.fromEntries(GROUPS.map((g) => [g.key, rows.filter((r) => r.group === g.key)])) as Record<Group, Row[]>, [rows]);
  const queue = useMemo(() => GROUPS.flatMap((g) => byGroup[g.key]).filter((r) => !r.sentAt && r.draft), [byGroup]);
  const sel = rows.find((r) => r.id === selected) ?? null;

  if (focus) return <Focus queue={queue} mode={mode} testTo={testTo} onExit={() => { setFocus(false); router.refresh(); }} patch={patch} />;

  return (
    <>
      <div className="toolbar">
        <div className="tabs">
          <Link href="/review?role=PM" className={role === 'PM' ? 'on' : ''}>Product Manager</Link>
          <Link href="/review?role=SPM" className={role === 'SPM' ? 'on' : ''}>Senior PM</Link>
        </div>
        <span className="muted small">Shortlist: top {topN} scoring <b>{threshold}</b> or more</span>
        <span className="sp" />
        <button className="btn" disabled={drafting} onClick={async () => { setDrafting(true); setDraftMsg(await runDrafts(setDraftMsg)); setDrafting(false); router.refresh(); }}>
          {drafting ? 'Updating…' : 'Update drafts'}
        </button>
        <button className="btn primary" disabled={!queue.length} onClick={() => setFocus(true)}>Start reviewing</button>
      </div>
      {draftMsg && <p className="note muted" style={{ marginTop: -20 }}>{draftMsg}</p>}

      {GROUPS.map((g) => (
        <section className="section" key={g.key}>
          <div className="section-head"><h2>{g.title}</h2><span className="faint small">{byGroup[g.key].length} · {g.hint}</span></div>
          <div className="list">
            {byGroup[g.key].length === 0 && <div className="empty">No one here.</div>}
            {byGroup[g.key].map((r) => <ListRow key={r.id} r={r} threshold={threshold} on={r.id === selected} onClick={() => setSelected(r.id)} />)}
          </div>
        </section>
      ))}

      {sel && (
        <>
          <div className="scrim" onClick={() => setSelected(null)} />
          <aside className="panel" role="dialog" aria-label={sel.name}>
            <button className="btn ghost close" onClick={() => setSelected(null)} aria-label="Close">✕</button>
            <Panel key={sel.id} r={sel} mode={mode} testTo={testTo} patch={patch} />
          </aside>
        </>
      )}
    </>
  );
}

function ListRow({ r, threshold, on, onClick }: { r: Row; threshold: number; on: boolean; onClick: () => void }) {
  return (
    <button className={`row${on ? ' sel' : ''}`} onClick={onClick}>
      <span className="rk">{r.rank ?? '–'}</span>
      <span className="nm">{r.name}</span>
      <span className="score">
        {r.total !== null ? r.total.toFixed(1) : '—'}
        <span className={`bar${r.total !== null && r.total >= threshold ? ' hi' : ''}`}>
          <i style={{ width: `${r.total ?? 0}%` }} />
          <span className="cut" style={{ left: `${threshold}%` }} />
        </span>
      </span>
      <span className="badge">{r.roleApplied}</span>
      <span className="crit">{r.topCriterion ?? '—'}</span>
      <span className="st"><span className={`pill ${r.status === 'processing' ? '' : r.status}`}>{STATUS_LABEL[r.status]}</span></span>
    </button>
  );
}

function Dots({ score }: { score: number | null }) {
  if (score === null) return <span className="dots"><span className="na">no evidence</span></span>;
  return <span className="dots" aria-label={`${score} out of 5`}>{[1, 2, 3, 4, 5].map((i) => <i key={i} className={i <= score ? 'on' : ''} />)}</span>;
}

// Panel body: brief + action, probes, scores, email, personal details — in that order.
function Panel({ r, mode, testTo, patch, draft: ext, setDraft: setExt, hideSend }: {
  r: Row; mode: EmailMode; testTo: string | null; patch: (id: number, p: Partial<Row>) => void;
  draft?: Draft; setDraft?: (d: Draft) => void; hideSend?: boolean;
}) {
  const [own, setOwn] = useState<Draft>({ type: r.draft?.type ?? null, subject: r.draft?.subject ?? '', body: r.draft?.body ?? '' });
  const d = ext ?? own;
  const setD = setExt ?? setOwn;
  const [msg, setMsg] = useState<{ ok: boolean; t: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [opened, setOpened] = useState(false);
  const [editing, setEditing] = useState(false);
  const [contact, setContact] = useState({ name: r.name, email: r.email ?? '' });
  const probes = r.criteria.filter((c) => c.probe);
  const dirty = d.subject !== (r.draft?.subject ?? '') || d.body !== (r.draft?.body ?? '');
  const real = r.flags.filter((f) => !INFO_FLAGS.has(f.type));
  const info = r.flags.filter((f) => INFO_FLAGS.has(f.type));

  const send = async () => {
    setBusy(true); setMsg(null);
    try {
      if (mode === 'gmail') {
        window.open(gmailUrl(r.email ?? '', merge(d.subject, r.name), merge(d.body, r.name)), '_blank', 'noopener');
        await api(`/api/drafts/${r.id}`, 'PATCH', { subject: d.subject, body: d.body });
        setOpened(true); setMsg({ ok: true, t: 'Opened in Gmail. Press Send there, then mark it as sent.' });
      } else {
        const j = await api(`/api/send/${r.id}`, 'POST', { subject: d.subject, body: d.body });
        patch(r.id, { sentAt: j.sentAt, status: 'sent' }); setMsg({ ok: true, t: `Sent to ${j.to}` });
      }
    } catch (e) { setMsg({ ok: false, t: e instanceof Error ? e.message : String(e) }); }
    setBusy(false);
  };

  return (
    <>
      <p className="who">{r.name}</p>
      <div className="muted small">
        #{r.rank ?? '–'} · {r.total !== null ? `${r.total.toFixed(1)} / 100` : 'not scored'}
        {r.total !== null && r.scoredWeight < 100 && ` · based on ${r.scoredWeight}% of the rubric`} · applied {r.roleApplied}
      </div>

      <div className="block">
        <h2>Brief</h2>
        <p className="brief">{r.brief ?? <span className="muted">No interview brief: briefs are written for the shortlist only.</span>}</p>
        <div className="action">
          <span className={`pill ${r.group === 'invite' ? 'ready' : r.group === 'eye' ? 'check' : 'plain'}`}>Recommended</span>
          {r.action}
        </div>
      </div>

      {(real.length > 0 || info.length > 0 || r.errorMessage) && (
        <div className="block flags">
          {r.errorMessage && <div className="flag">{r.errorMessage}</div>}
          {real.map((f, i) => <div key={i} className="flag"><b>{FLAG_LABEL[f.type] ?? f.type}.</b> {stripLabel(f.detail, FLAG_LABEL[f.type])}</div>)}
          {info.map((f, i) => <div key={`i${i}`} className="flag info">{f.detail}</div>)}
        </div>
      )}

      {probes.length > 0 && (
        <div className="block">
          <h2>Probe questions</h2>
          <ul className="probes">{probes.map((p) => <li key={p.name}>{p.probe} <span className="faint small">({p.name})</span></li>)}</ul>
        </div>
      )}

      <div className="block">
        <h2>Scores</h2>
        {r.criteria.map((c) => (
          <div className="crit-row" key={c.name}>
            <span className="cn">{c.name}<span className="cw">{c.weight}%</span></span>
            <Dots score={c.score} />
            <div className="why">
              {c.reason}
              {c.evidence && (
                <details className="ev">
                  <summary>Show evidence</summary>
                  <blockquote>“{c.evidence}”{c.verified === false && <span className="note err"> (not found word for word in the CV)</span>}</blockquote>
                </details>
              )}
            </div>
          </div>
        ))}
      </div>

      {r.draft && (
        <div className="block">
          <h2>Email · {d.type === 'invite' ? 'interview invite' : 'rejection'}</h2>
          {r.sentAt ? (
            <>
              <p className="muted small">Subject: {d.subject}</p>
              <pre className="brief" style={{ whiteSpace: 'pre-wrap', fontFamily: 'inherit' }}>{merge(d.body, r.name)}</pre>
              <p><span className="pill sent">Sent {fmt(r.sentAt)}</span></p>
            </>
          ) : (
            <>
              <input className="field" value={d.subject} onChange={(e) => setD({ ...d, subject: e.target.value })} style={{ marginBottom: 8 }} />
              <textarea className="field" value={d.body} onChange={(e) => setD({ ...d, body: e.target.value })} />
              <div className="faint small">{'{{first_name}}'} becomes “{firstName(r.name)}” when sent{testTo && mode === 'resend' ? ` · test mode: goes to ${testTo}` : ''}.</div>
              <div className="send">
                {!hideSend && (
                  <button className="btn primary" disabled={busy || (!r.email && !(testTo && mode === 'resend'))} onClick={send}>
                    {busy ? 'Sending…' : mode === 'gmail' ? 'Send (opens Gmail)' : 'Send'}
                  </button>
                )}
                {mode === 'gmail' && opened && (
                  <button className="btn" disabled={busy} onClick={async () => {
                    try { const j = await api(`/api/send/${r.id}`, 'POST', { subject: d.subject, body: d.body, manual: true }); patch(r.id, { sentAt: j.sentAt, status: 'sent' }); }
                    catch (e) { setMsg({ ok: false, t: e instanceof Error ? e.message : String(e) }); }
                  }}>I sent it: mark as sent</button>
                )}
                <button className="btn ghost" disabled={busy || !dirty} onClick={async () => {
                  try { await api(`/api/drafts/${r.id}`, 'PATCH', { subject: d.subject, body: d.body }); setMsg({ ok: true, t: 'Saved' }); }
                  catch (e) { setMsg({ ok: false, t: e instanceof Error ? e.message : String(e) }); }
                }}>Save edits</button>
                {msg && <span className={`note ${msg.ok ? 'ok' : 'err'}`}>{msg.t}</span>}
              </div>
            </>
          )}
        </div>
      )}

      <div className="pd">
        {editing ? (
          <span style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
            <input className="field small" style={{ width: 160 }} value={contact.name} onChange={(e) => setContact({ ...contact, name: e.target.value })} />
            <input className="field small" style={{ width: 220 }} value={contact.email} onChange={(e) => setContact({ ...contact, email: e.target.value })} />
            <button onClick={async () => {
              try { await api(`/api/candidates/${r.id}`, 'PATCH', contact); patch(r.id, { name: contact.name, email: contact.email }); setEditing(false); }
              catch (e) { setMsg({ ok: false, t: e instanceof Error ? e.message : String(e) }); }
            }}>save</button>
          </span>
        ) : (
          <>{r.name} · {r.email ?? 'no email'} · {r.phone ?? 'no phone'} · {r.fileName} · <button onClick={() => setEditing(true)}>edit</button></>
        )}
      </div>
    </>
  );
}

// One candidate at a time. Clicking a send button sends; a keyboard shortcut must be pressed twice.
function Focus({ queue: initialQueue, mode, testTo, onExit, patch }: {
  queue: Row[]; mode: EmailMode; testTo: string | null; onExit: () => void; patch: (id: number, p: Partial<Row>) => void;
}) {
  const [queue] = useState(initialQueue);
  const [i, setI] = useState(0);
  const [done, setDone] = useState<Record<number, string>>({});
  const [draft, setDraft] = useState<Draft>({ type: null, subject: '', body: '' });
  const [armed, setArmed] = useState<'invite' | 'rejection' | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; t: string } | null>(null);
  const r = queue[i];
  const busyRef = useRef(false);

  useEffect(() => {
    if (!r) return;
    setDraft({ type: r.draft?.type ?? null, subject: r.draft?.subject ?? '', body: r.draft?.body ?? '' });
    setArmed(null); setMsg(null);
  }, [r]);

  const next = useCallback(() => setI((x) => x + 1), []);

  const act = useCallback(async (type: 'invite' | 'rejection', viaKey: boolean) => {
    if (!r || busyRef.current || done[r.id]) return;
    if (draft.type !== type) {
      busyRef.current = true; setBusy(true); setMsg({ ok: true, t: `Writing ${type === 'invite' ? 'an invite' : 'a rejection'}…` });
      try {
        const e = await api(`/api/drafts/${r.id}`, 'POST', { type });
        setDraft({ type, subject: e.email_subject, body: e.email_body });
        patch(r.id, { draft: { type, subject: e.email_subject, body: e.email_body, edited: true } });
        setArmed(type);
        setMsg({ ok: true, t: `${type === 'invite' ? 'Invite' : 'Rejection'} drafted. Check it, then ${viaKey ? `press ${type === 'invite' ? 'I' : 'R'} again` : 'click again'} to send.` });
      } catch (err) { setMsg({ ok: false, t: err instanceof Error ? err.message : String(err) }); }
      busyRef.current = false; setBusy(false);
      return;
    }
    if (viaKey && armed !== type) { setArmed(type); setMsg({ ok: true, t: `Press ${type === 'invite' ? 'I' : 'R'} again to send.` }); return; }
    busyRef.current = true; setBusy(true); setMsg(null);
    try {
      if (mode === 'gmail') {
        window.open(gmailUrl(r.email ?? '', merge(draft.subject, r.name), merge(draft.body, r.name)), '_blank', 'noopener');
        const j = await api(`/api/send/${r.id}`, 'POST', { subject: draft.subject, body: draft.body, manual: true });
        patch(r.id, { sentAt: j.sentAt, status: 'sent' }); setDone((x) => ({ ...x, [r.id]: 'opened in Gmail' }));
      } else {
        const j = await api(`/api/send/${r.id}`, 'POST', { subject: draft.subject, body: draft.body });
        patch(r.id, { sentAt: j.sentAt, status: 'sent' }); setDone((x) => ({ ...x, [r.id]: `sent to ${j.to}` }));
      }
      setTimeout(next, 700);
    } catch (err) { setMsg({ ok: false, t: err instanceof Error ? err.message : String(err) }); }
    busyRef.current = false; setBusy(false);
  }, [r, draft, armed, mode, done, next, patch]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || e.metaKey || e.ctrlKey || e.altKey) return;
      const k = e.key.toLowerCase();
      if (k === 'i') { e.preventDefault(); act('invite', true); }
      else if (k === 'r') { e.preventDefault(); act('rejection', true); }
      else if (k === 's') { e.preventDefault(); next(); }
      else if (k === 'escape') onExit();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [act, next, onExit]);

  if (!r) {
    return (
      <div className="panel full" style={{ textAlign: 'center' }}>
        <p className="who" style={{ padding: 0 }}>All done</p>
        <p className="muted">{Object.keys(done).length} sent this session. Skipped candidates are still waiting in the list.</p>
        <button className="btn primary" onClick={onExit}>Back to the list</button>
      </div>
    );
  }
  return (
    <>
      <div className="focus-bar">
        <span className="muted small">Candidate {i + 1} of {queue.length}{testTo && mode === 'resend' ? ` · test mode: emails go to ${testTo}` : ''}</span>
        <span className="sp" />
        <button className="btn ghost" onClick={onExit}>Exit <kbd>Esc</kbd></button>
      </div>
      <div className="panel full">
        <Panel key={r.id} r={{ ...r, sentAt: r.sentAt }} mode={mode} testTo={testTo} patch={patch} draft={draft} setDraft={setDraft} hideSend />
        {done[r.id] && <p className="note ok" style={{ marginTop: 16 }}>✓ {done[r.id]}</p>}
        {msg && <p className={`note ${msg.ok ? 'muted' : 'err'}`} style={{ marginTop: 16 }}>{msg.t}</p>}
      </div>
      <div className="focus-actions">
        <button className={`btn primary${armed === 'invite' ? ' armed' : ''}`} disabled={busy || !!done[r.id]} onClick={() => act('invite', false)}>Send invite <kbd>I</kbd></button>
        <button className={`btn${armed === 'rejection' ? ' armed' : ''}`} disabled={busy || !!done[r.id]} onClick={() => act('rejection', false)}>Send rejection <kbd>R</kbd></button>
        <button className="btn ghost" disabled={busy} onClick={next}>Skip <kbd>S</kbd></button>
      </div>
    </>
  );
}
