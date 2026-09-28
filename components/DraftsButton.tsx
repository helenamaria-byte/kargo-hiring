'use client';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { runDrafts } from './runDrafts';

export function DraftsButton({ pending }: { pending: number }) {
  const router = useRouter();
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);
  return (
    <span>
      <button disabled={busy} onClick={async () => {
        setBusy(true);
        const r = await runDrafts(setMsg);
        setMsg(r);
        setBusy(false);
        router.refresh();
      }}>
        {busy ? 'Generating…' : pending ? `Generate ${pending} missing draft${pending === 1 ? '' : 's'}` : 'Refresh drafts for current ranking'}
      </button>{' '}
      <span className="muted">{msg}</span>
    </span>
  );
}
