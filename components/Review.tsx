'use client';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Policy } from '@/lib/policy';
import type { ReviewData, Row } from '@/lib/review';
import { runDrafts } from './runDrafts';

type Group = 'invite' | 'eye' | 'no';
type Status = 'ready' | 'sent' | 'check' | 'processing' | 'error';
type Live = Row & { group: Group; status: Status; tied: boolean; stale: boolean; action: string; liveFlags: Row['flags'] };
type Draft = { type: 'invite' | 'rejection' | null; subject: string; body: string };

const STATUS_LABEL: Record<Status, string> = { ready: 'Ready', sent: 'Sent', check: 'Needs checking', processing: 'Processing', error: 'Error' };
const GROUPS: { key: Group; title: string }[] = [
  { key: 'invite', title: 'Invite' },
  { key: 'eye', title: 'Needs your eye' },
  { key: 'no', title: 'Not moving forward' },
];
const REVIEW_FLAGS = new Set(['strong_outsider', 'prompt_injection', 'scores_inconsistent', 'thin_evidence', 'tied_cutoff', 'other_role', 'duplicate', 'name_not_detected', 'email_not_detected', 'name_from_file']);
const FLAG_LABEL: Record<string, string> = {
  strong_outsider: 'Strong outsider', prompt_injection: 'Text addressed to AI', scores_inconsistent: 'Scores inconsistent',
  thin_evidence: 'Thin evidence', tied_cutoff: 'Tied at cut-off', other_role: 'Fits other role', duplicate: 'Duplicate',
  name_not_detected: 'Name not found', email_not_detected: 'Email not found', name_from_file: 'Name from file name', role_assigned: 'Role assigned by score',
};
const PRESET_NAMES = { strict: 'Strict', balanced: 'Balanced', lenient: 'Lenient' } as const;

// Flag details sometimes start with their own label ("Scores inconsistent: …"); don't show it twice.
const stripLabel = (detail: string, label?: string) =>
  label && detail.toLowerCase().startsWith(label.toLowerCase()) ? detail.slice(label.length).replace(/^\s*(—\s*review\s*)?[:—–-]?\s*/i, '') : detail;
const fmt = (iso: string) => new Date(iso).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
const one = (n: number | null) => (n === null ? '—' : n.toFixed(1));
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

// Same rule as the server's ranking, run live in the browser so the controls respond instantly.
function classify(rows: Row[], threshold: number, topN: number): Live[] {
  const open = rows.filter((r) => r.total !== null && !r.duplicate && r.base !== 'error' && r.decision !== 'reject');
  const auto = new Set(open.slice(0, topN).filter((r) => r.total! >= threshold).map((r) => r.id));
  const cut = open[topN - 1]?.total ?? null;
  return rows.map((r) => {
    const invite = r.decision === 'invite' || auto.has(r.id);
    const tied = !invite && r.decision !== 'reject' && r.total !== null && r.total === cut && r.total >= threshold;
    const liveFlags = tied ? [...r.flags, { type: 'tied_cutoff', detail: `Tied at ${one(r.total)} with the last invite; left out on the tie-break (operations score, then evidence).` }] : r.flags;
    const needsEye = liveFlags.some((f) => REVIEW_FLAGS.has(f.type)) || r.base === 'error';
    const group: Group = invite ? 'invite' : r.decision === 'reject' ? 'no' : needsEye ? 'eye' : 'no';
    const status: Status = r.base === 'sent' ? 'sent' : r.base === 'error' ? 'error' : r.base === 'processing' ? 'processing' : needsEye ? 'check' : 'ready';
    const stale = !r.sentAt && !!r.draft && ((invite && r.draft.type !== 'invite') || (!invite && r.draft.type === 'invite' && !r.draft.edited));
    const first = liveFlags.find((f) => REVIEW_FLAGS.has(f.type));
    const action = r.decision === 'invite' ? 'Invite to interview (your pick)'
      : r.decision === 'reject' ? 'Send the rejection (your call)'
      : invite ? 'Invite to interview'
      : r.duplicate ? 'Duplicate CV: no email needed'
      : first ? `Look before deciding: ${FLAG_LABEL[first.type]?.toLowerCase() ?? first.type}`
      : 'Send the rejection';
    return { ...r, group, status, tied, stale, action, liveFlags };
  });
}

export function Review(d: ReviewData) {
  const router = useRouter();
  const [rows, setRows] = useState(d.rows);
  const [threshold, setThreshold] = useState(d.shortlist.threshold);
  const [topN, setTopN] = useState(d.shortlist.topN);
  const [policy, setPolicy] = useState<Policy>(d.policy);
  const [advanced, setAdvanced] = useState(false);
  const [rescoring, setRescoring] = useState(false);
  const [saved, setSaved] = useState<string>('');
  const [query, setQuery] = useState('');
  const [show, setShow] = useState<'all' | Group | 'unsent' | 'sent'>('all');
  const [sort, setSort] = useState<string>('rank');
  const [selected, setSelected] = useState<number | null>(null);
  const [focus, setFocus] = useState(false);
  const [draftMsg, setDraftMsg] = useState('');
  const [drafting, setDrafting] = useState(false);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => setRows(d.rows), [d.rows]);
  useEffect(() => { setPolicy(d.policy); }, [d.policy]);

  const live = useMemo(() => classify(rows, threshold, topN), [rows, threshold, topN]);
  const patch = useCallback((id: number, p: Partial<Row>) => setRows((rs) => rs.map((r) => (r.id === id ? { ...r, ...p } : r))), []);
  const counts = useMemo(() => Object.fromEntries(GROUPS.map((g) => [g.key, live.filter((r) => r.group === g.key).length])) as Record<Group, number>, [live]);
  const staleCount = live.filter((r) => r.stale).length;

  // Shortlist settings save themselves a moment after the last change.
  const saveShortlist = (t: number, n: number) => {
    if (saveTimer.current) clearTimeout(saveTimer.current);
    setSaved('Saving…');
    saveTimer.current = setTimeout(async () => {
      try { await api('/api/settings', 'POST', { shortlist: { threshold: t, topN: n } }); setSaved('Saved'); }
      catch (e) { setSaved(e instanceof Error ? e.message : 'Could not save'); }
    }, 700);
  };
  const applyPolicy = async (p: Partial<Policy>) => {
    const next = { ...policy, ...p };
    setPolicy(next); setRescoring(true);
    try { await api('/api/settings', 'POST', { scoring: next }); router.refresh(); }
    catch (e) { setSaved(e instanceof Error ? e.message : 'Could not apply'); }
    setRescoring(false);
  };
  const decide = async (id: number, decision: 'invite' | 'reject' | null) => {
    patch(id, { decision });
    try { await api(`/api/candidates/${id}`, 'PATCH', { decision }); } catch (e) { setSaved(e instanceof Error ? e.message : 'Could not save'); }
  };

  const visible = useMemo(() => {
    const ql = query.trim().toLowerCase();
    let out = live.filter((r) => !ql || r.name.toLowerCase().includes(ql) || (r.topCriterion ?? '').toLowerCase().includes(ql));
    if (show === 'unsent') out = out.filter((r) => !r.sentAt);
    else if (show === 'sent') out = out.filter((r) => r.sentAt);
    else if (show !== 'all') out = out.filter((r) => r.group === show);
    if (sort === 'name') out = [...out].sort((a, b) => a.name.localeCompare(b.name));
    else if (sort !== 'rank') {
      const ci = Number(sort);
      out = [...out].sort((a, b) => (b.criteria[ci]?.score ?? -1) - (a.criteria[ci]?.score ?? -1) || a.order - b.order);
    }
    return out;
  }, [live, query, show, sort]);
  const flat = visible; // keyboard order
  const sel = live.find((r) => r.id === selected) ?? null;
  const queue = useMemo(() => GROUPS.flatMap((g) => live.filter((r) => r.group === g.key)).filter((r) => !r.sentAt && r.draft), [live]);

  // j/k or arrows move through the list, Enter opens, Esc closes; ★/✕ shortcuts on the selected row.
  useEffect(() => {
    if (focus) return;
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || e.metaKey || e.ctrlKey || e.altKey) return;
      const i = flat.findIndex((r) => r.id === selected);
      if (e.key === 'j' || e.key === 'ArrowDown') { e.preventDefault(); setSelected(flat[Math.min(flat.length - 1, i + 1)]?.id ?? null); }
      else if (e.key === 'k' || e.key === 'ArrowUp') { e.preventDefault(); setSelected(flat[Math.max(0, i - 1)]?.id ?? null); }
      else if (e.key === 'Escape') setSelected(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [flat, selected, focus]);

  if (focus) return <Focus queue={queue} mode={d.mode} testTo={d.testTo} onExit={() => { setFocus(false); router.refresh(); }} patch={patch} decide={decide} />;

  const bins = Array.from({ length: 20 }, (_, i) => live.filter((r) => r.total !== null && !r.duplicate && Math.min(19, Math.floor(r.total / 5)) === i).length);
  const maxBin = Math.max(1, ...bins);

  return (
    <>
      <div className="toolbar">
        <div className="tabs">
          <Link href="/review?role=PM" className={d.role === 'PM' ? 'on' : ''}>Product Manager</Link>
          <Link href="/review?role=SPM" className={d.role === 'SPM' ? 'on' : ''}>Senior PM</Link>
        </div>
        <span className="sp" />
        <button className={`btn${staleCount ? ' primary' : ''}`} disabled={drafting} title="Write briefs and emails to match the current shortlist"
          onClick={async () => { setDrafting(true); setDraftMsg(await runDrafts(setDraftMsg)); setDrafting(false); router.refresh(); }}>
          {drafting ? 'Updating…' : staleCount ? `Update drafts (${staleCount})` : 'Update drafts'}
        </button>
        <button className="btn dark" disabled={!queue.length} onClick={() => setFocus(true)}>Start reviewing</button>
      </div>
      {draftMsg && <p className="note muted" style={{ marginTop: -22 }}>{draftMsg}</p>}

      <section className="controls">
        <div className="ctl">
          <div className="ctl-head"><h2>Shortlist threshold</h2><span className="big">{threshold}</span></div>
          <div className="hist" aria-hidden>
            {bins.map((n, i) => <i key={i} className={i * 5 >= threshold ? 'hi' : ''} style={{ height: `${(n / maxBin) * 100}%` }} title={`${i * 5}–${i * 5 + 5}: ${n}`} />)}
            <span className="line" style={{ left: `${threshold}%` }} />
          </div>
          <input type="range" min={30} max={95} value={threshold} className="slider" aria-label="Shortlist threshold"
            onChange={(e) => { const t = Number(e.target.value); setThreshold(t); saveShortlist(t, topN); }} />
          <div className="faint small">Invites need at least this score</div>
        </div>
        <div className="ctl narrow">
          <div className="ctl-head"><h2>Invites</h2></div>
          <div className="stepper">
            <button className="btn" onClick={() => { const n = Math.max(1, topN - 1); setTopN(n); saveShortlist(threshold, n); }} aria-label="Fewer">−</button>
            <span className="big">{topN}</span>
            <button className="btn" onClick={() => { const n = Math.min(20, topN + 1); setTopN(n); saveShortlist(threshold, n); }} aria-label="More">+</button>
          </div>
          <div className="faint small">most per role</div>
        </div>
        <div className="ctl">
          <div className="ctl-head"><h2>Strictness</h2>{rescoring && <span className="faint small">Re-ranking…</span>}</div>
          <div className="seg wide">
            {(['strict', 'balanced', 'lenient'] as const).map((p) => (
              <button key={p} className={policy.preset === p ? 'on' : ''} disabled={rescoring} onClick={() => applyPolicy({ preset: p, ...presetValues(p) })}>{PRESET_NAMES[p]}</button>
            ))}
          </div>
          <button className="linkish small" onClick={() => setAdvanced((a) => !a)}>{advanced ? 'Hide rules' : 'Fine-tune rules'}{policy.preset === 'custom' ? ' · custom' : ''}</button>
          {advanced && (
            <div className="rules">
              <label>Two scoring runs
                <select className="field" value={policy.combine} disabled={rescoring} onChange={(e) => applyPolicy({ preset: 'custom', combine: e.target.value as Policy['combine'] })}>
                  <option value="average">average them</option><option value="lower">take the lower</option>
                </select></label>
              <label>Number needed in evidence
                <select className="field" value={policy.numberRule} disabled={rescoring} onChange={(e) => applyPolicy({ preset: 'custom', numberRule: e.target.value as Policy['numberRule'] })}>
                  <option value="off">never</option><option value="five">for a 5</option><option value="four">for a 4 or 5</option>
                </select></label>
              <label>One CV line can back
                <select className="field" value={String(Math.min(policy.lineReuse, 99))} disabled={rescoring} onChange={(e) => applyPolicy({ preset: 'custom', lineReuse: Number(e.target.value) })}>
                  <option value="1">1 criterion</option><option value="2">2 criteria</option><option value="99">any number</option>
                </select></label>
              <label>Summary-only claims score up to
                <select className="field" value={String(policy.summaryMax)} disabled={rescoring} onChange={(e) => applyPolicy({ preset: 'custom', summaryMax: Number(e.target.value) })}>
                  <option value="1">1 (no credit)</option><option value="2">2</option><option value="3">3</option>
                </select></label>
            </div>
          )}
        </div>
        <div className="ctl-foot">
          <span><b>{counts.invite}</b> invite · <b>{counts.eye}</b> need your eye · <b>{counts.no}</b> not moving forward</span>
          <span className="faint small">{saved}</span>
        </div>
      </section>

      <div className="filters">
        <input className="field search" placeholder="Search name or strength…" value={query} onChange={(e) => setQuery(e.target.value)} />
        <div className="chips">
          {([['all', 'All'], ['invite', 'Invite'], ['eye', 'Needs your eye'], ['no', 'Not moving forward'], ['unsent', 'Not sent'], ['sent', 'Sent']] as const).map(([k, l]) => (
            <button key={k} className={`chip${show === k ? ' on' : ''}`} onClick={() => setShow(k)}>{l}</button>
          ))}
        </div>
        <select className="field sort" value={sort} onChange={(e) => setSort(e.target.value)} aria-label="Sort">
          <option value="rank">Sort: rank</option>
          <option value="name">Sort: name</option>
          {d.criteria.map((c, i) => <option key={c} value={String(i)}>Sort: {c}</option>)}
        </select>
      </div>

      {GROUPS.filter((g) => show === 'all' || show === 'unsent' || show === 'sent' || show === g.key).map((g) => {
        const list = visible.filter((r) => r.group === g.key);
        return (
          <section className="section" key={g.key}>
            <div className="section-head"><h2>{g.title}</h2><span className="faint small">{list.length}</span></div>
            <div className="list">
              {list.length === 0 && <div className="empty">No one here.</div>}
              {list.map((r) => (
                <ListRow key={r.id} r={r} threshold={threshold} on={r.id === selected} onClick={() => setSelected(r.id)} decide={decide} />
              ))}
            </div>
          </section>
        );
      })}
      <p className="faint small">Scoring rules: {d.policyText}. Keyboard: <kbd>J</kbd>/<kbd>K</kbd> to move, <kbd>Esc</kbd> to close.</p>

      {sel && (
        <>
          <div className="scrim" onClick={() => setSelected(null)} />
          <aside className="panel" role="dialog" aria-label={sel.name}>
            <button className="btn ghost close" onClick={() => setSelected(null)} aria-label="Close">✕</button>
            <Panel key={sel.id} r={sel} mode={d.mode} testTo={d.testTo} patch={patch} decide={decide} />
          </aside>
        </>
      )}
    </>
  );
}

function presetValues(p: 'strict' | 'balanced' | 'lenient'): Partial<Policy> {
  return {
    strict: { combine: 'lower', numberRule: 'four', lineReuse: 1, summaryMax: 1 },
    balanced: { combine: 'average', numberRule: 'five', lineReuse: 2, summaryMax: 2 },
    lenient: { combine: 'average', numberRule: 'off', lineReuse: 99, summaryMax: 3 },
  }[p] as Partial<Policy>;
}

function ListRow({ r, threshold, on, onClick, decide }: { r: Live; threshold: number; on: boolean; onClick: () => void; decide: (id: number, d: 'invite' | 'reject' | null) => void }) {
  return (
    <div className={`row${on ? ' sel' : ''}`} onClick={onClick} role="button" tabIndex={0} onKeyDown={(e) => e.key === 'Enter' && onClick()}>
      <span className="rk">{r.total !== null && !r.duplicate ? r.order + 1 : '–'}</span>
      <span className="nm">
        {r.name}
        {r.decision === 'invite' && <span className="tag pick">your pick</span>}
        {r.decision === 'reject' && <span className="tag no">your no</span>}
        {r.stale && <span className="tag stale" title="The draft email no longer matches this decision">email out of date</span>}
      </span>
      <span className="score">
        {one(r.total)}
        <span className={`bar${r.total !== null && r.total >= threshold ? ' hi' : ''}`}>
          <i style={{ width: `${r.total ?? 0}%` }} />
          <span className="cut" style={{ left: `${threshold}%` }} />
        </span>
      </span>
      <span className="badge">{r.roleApplied}</span>
      <span className="crit">{r.topCriterion ?? '—'}</span>
      <span className="st">
        <span className="quick" onClick={(e) => e.stopPropagation()}>
          <button title="Shortlist" className={r.decision === 'invite' ? 'on' : ''} disabled={!!r.sentAt} onClick={() => decide(r.id, r.decision === 'invite' ? null : 'invite')}>★</button>
          <button title="Not moving forward" className={r.decision === 'reject' ? 'on' : ''} disabled={!!r.sentAt} onClick={() => decide(r.id, r.decision === 'reject' ? null : 'reject')}>✕</button>
        </span>
        <span className={`pill ${r.status === 'processing' ? '' : r.status}`}>{STATUS_LABEL[r.status]}</span>
      </span>
    </div>
  );
}

function Dots({ score }: { score: number | null }) {
  if (score === null) return <span className="dots"><span className="na">no evidence</span></span>;
  return (
    <span className="dots" aria-label={`${score} out of 5`}>
      {[1, 2, 3, 4, 5].map((i) => <i key={i} className={i <= score ? 'on' : i - 0.5 === score ? 'half' : ''} />)}
      <span className="dv">{Number.isInteger(score) ? score : score.toFixed(1)}</span>
    </span>
  );
}

// Panel body: decision, brief + action, probes, scores, email, personal details.
function Panel({ r, mode, testTo, patch, decide, draft: ext, setDraft: setExt, hideSend }: {
  r: Live; mode: ReviewData['mode']; testTo: string | null; patch: (id: number, p: Partial<Row>) => void;
  decide: (id: number, d: 'invite' | 'reject' | null) => void;
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
  const real = r.liveFlags.filter((f) => f.type !== 'role_assigned');
  const info = r.liveFlags.filter((f) => f.type === 'role_assigned');
  const wantType = r.group === 'invite' ? 'invite' : 'rejection';

  const send = async () => {
    setBusy(true); setMsg(null);
    try {
      if (mode === 'gmail') {
        window.open(gmailUrl(r.email ?? '', merge(d.subject, r.name), merge(d.body, r.name)), '_blank', 'noopener');
        await api(`/api/drafts/${r.id}`, 'PATCH', { subject: d.subject, body: d.body });
        setOpened(true); setMsg({ ok: true, t: 'Opened in Gmail. Press Send there, then mark it as sent.' });
      } else {
        const j = await api(`/api/send/${r.id}`, 'POST', { subject: d.subject, body: d.body });
        patch(r.id, { sentAt: j.sentAt, base: 'sent' }); setMsg({ ok: true, t: `Sent to ${j.to}` });
      }
    } catch (e) { setMsg({ ok: false, t: e instanceof Error ? e.message : String(e) }); }
    setBusy(false);
  };
  const rewrite = async (type: 'invite' | 'rejection') => {
    setBusy(true); setMsg({ ok: true, t: `Writing ${type === 'invite' ? 'an invite' : 'a rejection'}…` });
    try {
      const e = await api(`/api/drafts/${r.id}`, 'POST', { type });
      setD({ type, subject: e.email_subject, body: e.email_body });
      patch(r.id, { draft: { type, subject: e.email_subject, body: e.email_body, edited: true } });
      setMsg({ ok: true, t: 'New draft ready. Check it before sending.' });
    } catch (err) { setMsg({ ok: false, t: err instanceof Error ? err.message : String(err) }); }
    setBusy(false);
  };

  return (
    <>
      <p className="who">{r.name}</p>
      <div className="muted small">
        #{r.total !== null && !r.duplicate ? r.order + 1 : '–'} · {r.total !== null ? `${one(r.total)} / 100` : 'not scored'}
        {r.total !== null && r.scoredWeight < 100 && ` · based on ${r.scoredWeight}% of the rubric`} · applied {r.roleApplied}
      </div>

      {!r.sentAt && !r.duplicate && (
        <div className="seg wide" style={{ marginTop: 16 }}>
          <button className={r.decision === null ? 'on' : ''} onClick={() => decide(r.id, null)}>Follow ranking</button>
          <button className={r.decision === 'invite' ? 'on' : ''} onClick={() => decide(r.id, 'invite')}>★ Shortlist</button>
          <button className={r.decision === 'reject' ? 'on' : ''} onClick={() => decide(r.id, 'reject')}>✕ Not moving forward</button>
        </div>
      )}

      <div className="block">
        <h2>Brief</h2>
        <p className="brief">{r.brief ?? <span className="muted">No interview brief yet: briefs are written for the shortlist when drafts are updated.</span>}</p>
        <div className="action"><span className={`pill ${r.group === 'invite' ? 'ready' : r.group === 'eye' ? 'check' : 'plain'}`}>Recommended</span>{r.action}</div>
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
              {d.type !== wantType && !r.duplicate && (
                <div className="flag" style={{ marginBottom: 10 }}>
                  This is a{d.type === 'invite' ? 'n invite' : ' rejection'}, but the candidate is now in “{r.group === 'invite' ? 'Invite' : r.group === 'eye' ? 'Needs your eye' : 'Not moving forward'}”.{' '}
                  <button className="linkish" disabled={busy} onClick={() => rewrite(wantType)}>Write {wantType === 'invite' ? 'an invite' : 'a rejection'} instead</button>
                </div>
              )}
              <input className="field" value={d.subject} onChange={(e) => setD({ ...d, subject: e.target.value })} style={{ marginBottom: 8 }} />
              <textarea className="field" value={d.body} onChange={(e) => setD({ ...d, body: e.target.value })} />
              <div className="faint small">{'{{first_name}}'} becomes “{firstName(r.name)}” when sent{testTo && mode === 'resend' ? ` · test mode: goes to ${testTo}` : ''}.</div>
              <div className="send">
                {!hideSend && (
                  <button className="btn primary" disabled={busy || (!r.email && !(testTo && mode === 'resend'))} onClick={send}>
                    {busy ? 'Working…' : mode === 'gmail' ? 'Send (opens Gmail)' : 'Send'}
                  </button>
                )}
                {mode === 'gmail' && opened && (
                  <button className="btn" disabled={busy} onClick={async () => {
                    try { const j = await api(`/api/send/${r.id}`, 'POST', { subject: d.subject, body: d.body, manual: true }); patch(r.id, { sentAt: j.sentAt, base: 'sent' }); }
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
function Focus({ queue: initialQueue, mode, testTo, onExit, patch, decide }: {
  queue: Live[]; mode: ReviewData['mode']; testTo: string | null; onExit: () => void;
  patch: (id: number, p: Partial<Row>) => void; decide: (id: number, d: 'invite' | 'reject' | null) => void;
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
        patch(r.id, { sentAt: j.sentAt, base: 'sent' }); setDone((x) => ({ ...x, [r.id]: 'opened in Gmail' }));
      } else {
        const j = await api(`/api/send/${r.id}`, 'POST', { subject: draft.subject, body: draft.body });
        patch(r.id, { sentAt: j.sentAt, base: 'sent' }); setDone((x) => ({ ...x, [r.id]: `sent to ${j.to}` }));
      }
      decide(r.id, type === 'invite' ? 'invite' : 'reject');
      setTimeout(next, 700);
    } catch (err) { setMsg({ ok: false, t: err instanceof Error ? err.message : String(err) }); }
    busyRef.current = false; setBusy(false);
  }, [r, draft, armed, mode, done, next, patch, decide]);

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
        <div className="progress"><i style={{ width: `${(i / Math.max(1, queue.length)) * 100}%` }} /></div>
        <button className="btn ghost" onClick={onExit}>Exit <kbd>Esc</kbd></button>
      </div>
      <div className="panel full">
        <Panel key={r.id} r={r} mode={mode} testTo={testTo} patch={patch} decide={decide} draft={draft} setDraft={setDraft} hideSend />
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
