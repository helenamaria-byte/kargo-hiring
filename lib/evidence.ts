// Splits a CV into numbered lines labelled by section, so every score can cite exactly one line and the
// code can check where it came from. Pure functions: no AI, no database.

export type Section = 'summary' | 'experience' | 'other';
export type Segment = { id: number; text: string; section: Section };

const SUMMARY_HEAD = /^(professional\s+|executive\s+|career\s+)?(summary|profile|synopsis|objective|about(\s+me)?|personal\s+statement|overview)\b/i;
const EXPERIENCE_HEAD = /^(work\s+|professional\s+|relevant\s+|employment\s+)?(experience|employment(\s+history)?|work\s+history|career\s+history|internships?)\b/i;
const OTHER_HEAD = /^(education|academic|skills|core\s+skills|key\s+skills|technical\s+skills|projects?|achievements|awards|certifications?|publications|languages|interests|hobbies|extra[- ]?curricular|leadership|volunteer(ing)?|positions\s+of\s+responsibility|scholastic|courses|references|contact|tools)\b/i;
const BULLET = /^[•●▪◦\-*–·►✓❖]\s*/;

function headingOf(line: string): Section | null {
  const t = line.replace(BULLET, '').trim();
  if (t.split(/\s+/).length > 5) return null;
  if (SUMMARY_HEAD.test(t)) return 'summary';
  if (EXPERIENCE_HEAD.test(t)) return 'experience';
  if (OTHER_HEAD.test(t)) return 'other';
  return null;
}

export function segmentCv(text: string): Segment[] {
  const segs: Segment[] = [];
  let section: Section = 'other';
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    const h = headingOf(line);
    if (h) { section = h; continue; }
    const prev = segs[segs.length - 1];
    // A wrapped bullet continues on a line that starts in lower case.
    if (prev && !BULLET.test(line) && /^[a-z(]/.test(line) && prev.section === section) {
      prev.text += ' ' + line;
      continue;
    }
    segs.push({ id: segs.length + 1, text: line.replace(BULLET, ''), section });
  }
  return segs;
}

export const formatSegments = (segs: Segment[]) =>
  segs.map((s) => `[L${s.id}${s.section === 'other' ? '' : ' ' + s.section.toUpperCase()}] ${s.text}`).join('\n');

const norm = (s: string) => s.toLowerCase().replace(/[“”"‘’'`]/g, '').replace(/[^a-z0-9%+]+/g, ' ').trim();

// The line the model cited, if the quote is really in it; otherwise any line that contains the quote.
export function locate(segs: Segment[], lineId: number | null | undefined, quote: string): Segment | null {
  const q = norm(quote);
  if (!q) return null;
  const probe = q.slice(0, 60);
  const cited = segs.find((s) => s.id === lineId);
  if (cited && norm(cited.text).includes(probe)) return cited;
  return segs.find((s) => norm(s.text).includes(probe)) ?? null;
}

// A 4 or 5 needs a number: a volume, a timeframe or an adoption count.
export const hasNumber = (s: string) =>
  /\d/.test(s) || /\b(one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|fifteen|twenty|thirty|forty|fifty|hundred|thousand|dozen|double|twice|half)\b/i.test(s);
