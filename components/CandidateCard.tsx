'use client';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import type { CardData } from '@/lib/dashboard';
import type { EmailMode } from '@/lib/config';
import type { Role } from '@/lib/scoring';

const gmailUrl = (to: string, su: string, body: string) =>
  `https://mail.google.com/mail/?view=cm&fs=1&to=${encodeURIComponent(to)}&su=${encodeURIComponent(su)}&body=${encodeURIComponent(body)}`;

const fmt = (iso: string) => new Date(iso).toLocaleString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });

async function call(url: string, method: string, body?: unknown) {
  const res = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(j.error ?? `HTTP ${res.status}`);
  return j;
}

export function CandidateCard({ c, role, mode, open }: { c: CardData; role: Role; mode: EmailMode; open: boolean }) {
  const router = useRouter();
  const [name, setName] = useState(c.name ?? '');
  const [email, setEmail] = useState(c.email ?? '');
  const [subject, setSubject] = useState(c.draft?.subject ?? '');
  const [body, setBody] = useState(c.draft?.body ?? '');
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [sentAt, setSentAt] = useState(c.sentAt);
  const [opened, setOpened] = useState(false);
  const first = name.trim().split(/\s+/)[0] || '';
  const merge = (t: string) => t.replace(/\{\{\s*first_name\s*\}\}/g, first);

  const run = async (fn: () => Promise<string>) => {
    setBusy(true); setMsg(null);
    try { setMsg({ ok: true, text: await fn() }); } catch (e) { setMsg({ ok: false, text: e instanceof Error ? e.message : String(e) }); }
    setBusy(false);
  };
  const contactDirty = name !== (c.name ?? '') || email !== (c.email ?? '');
  const draftDirty = subject !== (c.draft?.subject ?? '') || body !== (c.draft?.body ?? '');
  const probes = c.criteria.filter((x) => x.score === null && x.probe);
  const statusPill = sentAt ? <span className="pill good">Sent {fmt(sentAt)}</span>
    : c.duplicateOf ? <span className="pill warn">Duplicate</span>
    : c.status === 'error' ? <span className="pill bad">Error</span>
    : c.status === 'processing' ? <span className="pill">{c.rank ? 'Draft pending' : 'Processing'}</span>
    : c.draft?.type === 'invite' ? <span className="pill good">Invite drafted</span>
    : c.draft ? <span className="pill">Rejection drafted</span> : null;

  return (
    <details className="card" open={open}>
      <summary>
        <span className="rank">{c.rank ? `#${c.rank}` : '–'}</span>
        <span className="score">{c.total !== null ? `${c.total}` : '—'}<span className="muted">/100</span></span>
        <span className="name">{c.name ?? c.fileName}</span>
        <span className="pill">applied {c.roleApplied}</span>
        {statusPill}
        {c.flags.map((f, i) => <span key={i} className={`pill ${f.type === 'prompt_injection' ? 'bad' : 'warn'}`}>{flagLabel(f.type)}</span>)}
      </summary>

      <div className="body">
        <div className="row2">
          <label>Name <input value={name} onChange={(e) => setName(e.target.value)} disabled={!!sentAt} /></label>
          <label>Email <input value={email} onChange={(e) => setEmail(e.target.value)} disabled={!!sentAt} /></label>
        </div>
        <div className="muted">
          {c.phone ?? 'no phone'} · {c.fileName} · uploaded {fmt(c.createdAt)}
          {c.total !== null && c.scoredWeight < 100 && ` · score based on ${c.scoredWeight}% of the rubric weight (the rest had no evidence)`}
          {contactDirty && <> · <button disabled={busy} onClick={() => run(async () => { await call(`/api/candidates/${c.id}`, 'PATCH', { name, email }); router.refresh(); return 'Contact saved'; })}>Save contact</button></>}
        </div>

        {c.flags.length > 0 && (
          <div className="box"><h3>Flags</h3>{c.flags.map((f, i) => <div key={i} className="flag">{f.detail}</div>)}</div>
        )}

        {c.status === 'error' && (
          <div className="box err">
            {c.errorMessage}{' '}
            {c.canRetry
              ? <button disabled={busy} onClick={() => run(async () => { await call(`/api/rescore/${c.id}`, 'POST'); router.refresh(); return 'Rescored. Generate drafts to finish.'; })}>Retry scoring</button>
              : <span className="muted">Re-upload the file to retry.</span>}
          </div>
        )}

        {c.brief && <div className="box"><h3>Interview brief ({role})</h3>{c.brief}</div>}

        {c.rank !== null && (
          <table>
            <thead><tr><th>Criterion ({role} weight)</th><th>Score</th><th>Evidence from CV · reason</th></tr></thead>
            <tbody>
              {c.criteria.map((x) => (
                <tr key={x.name}>
                  <td>{x.name} <span className="muted">({x.weight}%)</span></td>
                  <td className="s">{x.score ?? <span className="muted">null</span>}</td>
                  <td className="q">
                    {x.evidence && <blockquote>“{x.evidence}”{x.quoteVerified === false && <span className="flag"> (quote not found word-for-word in the CV; check it)</span>}</blockquote>}
                    <div className="muted">{x.score === null ? 'No evidence in the CV, so not scored. ' : ''}{x.reason}</div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        {probes.length > 0 && (
          <div className="box"><h3>Probe questions</h3><ul style={{ margin: 0, paddingLeft: 18 }}>{probes.map((p) => <li key={p.name}>{p.probe} <span className="muted">({p.name})</span></li>)}</ul></div>
        )}

        {c.draft && (
          <div className="box" style={{ background: '#fff', border: '1px solid var(--line)' }}>
            <h3>Draft email: {c.draft.type === 'invite' ? 'interview invite' : 'rejection'} for {c.roleApplied} · to {email || '(no email)'}</h3>
            <input value={subject} onChange={(e) => setSubject(e.target.value)} disabled={!!sentAt} style={{ marginBottom: 6 }} />
            <textarea value={body} onChange={(e) => setBody(e.target.value)} disabled={!!sentAt} />
            <div className="muted" style={{ fontSize: 12 }}>{'{{first_name}}'} is replaced with “{name.split(/\s+/)[0] || '?'}” only when you send.</div>
            <div className="bar" style={{ marginTop: 8, marginBottom: 0 }}>
              {sentAt ? (
                <strong className="ok">Sent {fmt(sentAt)}</strong>
              ) : (
                <>
                  <button disabled={busy || !draftDirty} onClick={() => run(async () => { await call(`/api/drafts/${c.id}`, 'PATCH', { subject, body }); return 'Draft saved'; })}>Save edits</button>
                  <button
                    className="primary"
                    disabled={busy || !email || contactDirty || (/\{\{\s*first_name\s*\}\}/.test(subject + body) && !first)}
                    title={contactDirty ? 'Save the contact details first' : ''}
                    onClick={() => {
                      if (mode === 'resend') {
                        if (!confirm(`Send this ${c.draft!.type === 'invite' ? 'invite' : 'rejection'} to ${name || '(no name)'} <${email}> now?`)) return;
                        run(async () => { const j = await call(`/api/send/${c.id}`, 'POST', { subject, body }); setSentAt(j.sentAt); return 'Sent'; });
                        return;
                      }
                      // Gmail mode: the real name is merged now, at send time, and the email opens in Arjun's Gmail.
                      window.open(gmailUrl(email, merge(subject), merge(body)), '_blank', 'noopener');
                      setOpened(true);
                      run(async () => { await call(`/api/drafts/${c.id}`, 'PATCH', { subject, body }); return 'Opened in Gmail: press Send there, then mark it as sent here.'; });
                    }}
                  >
                    {mode === 'gmail' ? 'Confirm & Send (opens Gmail)' : 'Confirm & Send'}
                  </button>
                  {mode === 'gmail' && opened && (
                    <button disabled={busy} onClick={() => run(async () => { const j = await call(`/api/send/${c.id}`, 'POST', { subject, body, manual: true }); setSentAt(j.sentAt); return 'Marked as sent'; })}>
                      I sent it: mark as sent
                    </button>
                  )}
                  {mode === 'gmail' && (
                    <a href={`mailto:${encodeURIComponent(email)}?subject=${encodeURIComponent(merge(subject))}&body=${encodeURIComponent(merge(body))}`} onClick={() => setOpened(true)} style={{ fontSize: 12 }}>
                      or use your mail app
                    </a>
                  )}
                  {!email && <span className="err">Add an email address first.</span>}
                  {email && !first && /\{\{\s*first_name\s*\}\}/.test(subject + body) && <span className="err">Add the candidate&apos;s name first.</span>}
                  {contactDirty && <span className="flag">Save the contact details before sending.</span>}
                </>
              )}
              {msg && <span className={msg.ok ? 'ok' : 'err'}>{msg.text}</span>}
            </div>
          </div>
        )}
        {!c.draft && msg && <span className={msg.ok ? 'ok' : 'err'}>{msg.text}</span>}
      </div>
    </details>
  );
}

function flagLabel(t: string) {
  return ({
    prompt_injection: 'Text addressed to AI',
    strong_outsider: 'Strong outsider: review',
    duplicate: 'Duplicate',
    name_not_detected: 'Name not found',
    email_not_detected: 'Email not found',
    other_role: 'Fits other role',
  } as Record<string, string>)[t] ?? t;
}
