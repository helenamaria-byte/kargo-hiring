import { recompute } from '@/lib/pipeline';
import { PRESETS, type Policy } from '@/lib/policy';
import { loadSettings, saveSetting } from '@/lib/settings';

export const maxDuration = 120;

export async function GET() {
  try { return Response.json(await loadSettings()); }
  catch (e) { return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 }); }
}

// Saves strictness and/or shortlist settings. A strictness change re-applies the rules to every stored
// scoring run in code (no AI calls) and re-ranks everyone.
export async function POST(req: Request) {
  const body = await req.json();
  try {
    if (body.shortlist) {
      const threshold = Number(body.shortlist.threshold), topN = Math.round(Number(body.shortlist.topN));
      if (!(threshold >= 0 && threshold <= 100) || !(topN >= 1 && topN <= 20)) return Response.json({ error: 'threshold 0–100, invites 1–20' }, { status: 400 });
      await saveSetting('shortlist', { threshold, topN });
    }
    let recomputed = 0;
    if (body.scoring) {
      const s = body.scoring as Partial<Policy>;
      const base = s.preset && s.preset !== 'custom' ? PRESETS[s.preset] : (await loadSettings()).policy;
      const policy: Policy = {
        ...base, ...s,
        combine: s.combine === 'lower' ? 'lower' : s.combine === 'average' ? 'average' : base.combine,
        numberRule: (['four', 'five', 'off'] as const).includes(s.numberRule as never) ? s.numberRule! : base.numberRule,
        lineReuse: Math.max(1, Math.min(99, Math.round(Number(s.lineReuse ?? base.lineReuse)))),
        summaryMax: Math.max(1, Math.min(5, Math.round(Number(s.summaryMax ?? base.summaryMax)))),
      };
      await saveSetting('scoring', policy);
      recomputed = (await recompute()).candidates;
    }
    return Response.json({ ...(await loadSettings()), recomputed });
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
