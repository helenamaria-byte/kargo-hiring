// Step 1: pull name, email and phone out of the raw CV text — in code, with no AI call,
// so personal details never leave this server. Everything downstream only sees `redacted`.

export type PII = { name: string | null; email: string | null; phone: string | null };
export type NameSource = 'cv' | 'file' | null;

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const PHONE_RE = /(?:\+?\d[\d\s().-]{7,}\d)/g;
// Any web address: profile and portfolio links usually contain the person's name (pranavjoshi.vercel.app).
const URL_RE = /(?:https?:\/\/|www\.)\S+|\b[\w-]+(?:\.[\w-]+)*\.(?:com|in|io|app|dev|me|co|net|org|ai|xyz|site|page|tech|link|bio|portfolio)(?:\/[^\s,;|)]*)?/gi;
const NOT_A_NAME = /\b(university|college|institute|school|academy|iit|iim|imt|nit|bits|iiit|xlri|isb|resume|résumé|curriculum|vitae|cv|profile|summary|synopsis|contact|objective|experience|education|skills|address|email|phone|mobile|product|manager|engineer|senior|operations|linkedin|portfolio|strategy|strategic|marketing|leader|lead|corporate|executive|advisory|growth|ecommerce|commerce|consulting|analyst|founder|head|director|india|delhi|mumbai|bangalore|bengaluru|pune|chennai|hyderabad|kolkata|gurgaon|gurugram|noida|new|core|professional|achievements|projects|certifications|publications|research|scholastic|technical|work|history|career|key|highlights|languages|interests)\b/i;

// PDFs often run text together: "ROHAN MEHTARohan Mehta", "tracking.SNEHA KULKARNI", "REDDYsquad_5@x.co",
// "1111190000priya-k". Put a space at those seams so names, emails and links can be found and removed.
export function unglue(text: string): string {
  return text
    .replace(/([A-Z]{2,})([a-z][\w.%+-]*@)/g, '$1 $2') // REDDYsquad_5@ -> REDDY squad_5@ (before the next rule)
    .replace(/([A-Z]{2,})([A-Z][a-z])/g, '$1 $2') // MEHTARohan -> MEHTA Rohan
    .replace(/([a-z.,;:)])([A-Z]{2,}\b)/g, '$1 $2') // tracking.SNEHA / MehtaROHAN -> split
    .replace(/(\d{3,})([A-Za-z])/g, '$1 $2'); // 11111priya -> 11111 priya
}

function isPhone(candidate: string): boolean {
  const digits = candidate.replace(/\D/g, '');
  if (digits.length < 10 || digits.length > 13) return false;
  // "2015-2019 2019-2021" is two date ranges, not a phone number.
  const groups = candidate.split(/[^\d]+/).filter(Boolean);
  if (groups.every((g) => /^(19|20)\d{2}$/.test(g))) return false;
  return true;
}

function tidyName(s: string): string {
  return s
    .trim()
    .split(/\s+/)
    .map((w) => (w === w.toUpperCase() || w === w.toLowerCase() ? w[0].toUpperCase() + w.slice(1).toLowerCase() : w))
    .join(' ');
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const isNameWord = (w: string) => /^[A-Z][a-z'’.-]+$/.test(w) || /^[A-Z][A-Z'’.-]+$/.test(w);

// Finds a person's name anywhere in the text. CV headers can sit at the start or, in some PDFs, at the
// very end of the extracted text, and are often printed twice (upper case + title case).
function findName(text: string, lines: string[], emailLocal: string): string | null {
  const labelled = lines.slice(0, 20).map((l) => l.match(/^\s*(?:full\s+)?name\s*[:\-–]\s*(.+)$/i)?.[1]).find(Boolean);
  if (labelled) return tidyName(labelled.replace(/[|•·,].*$/, ''));

  let best: { name: string; score: number } | null = null;
  lines.forEach((line, i) => {
    for (const seg of line.replace(EMAIL_RE, ' ').replace(PHONE_RE, ' ').split(/\s*[|•·,;]\s*|\s{2,}|(?<=[a-z])\.\s+/)) {
      let words = seg.trim().split(/\s+/).filter(Boolean);
      // "ROHAN MEHTA Rohan Mehta" -> "Rohan Mehta"
      if (words.length >= 4 && words.length % 2 === 0) {
        const h = words.length / 2;
        if (words.slice(0, h).join(' ').toLowerCase() === words.slice(h).join(' ').toLowerCase()) words = words.slice(0, h);
      }
      if (words.length < 2 || words.length > 3 || !words.every(isNameWord) || NOT_A_NAME.test(words.join(' '))) continue;
      const name = tidyName(words.join(' '));
      let score = 0;
      if (text.includes(name.toUpperCase()) && text.includes(name)) score += 3; // printed in both cases: a header
      if (words.some((w) => w.length >= 3 && emailLocal.includes(w.toLowerCase()))) score += 3;
      if (i <= 2 || i >= lines.length - 3) score += 2; // header position
      if (seg.trim() === line.trim()) score += 1; // the name is the whole line
      if (!best || score > best.score) best = { name, score };
    }
  });
  return best && (best as { score: number }).score >= 3 ? (best as { name: string }).name : null;
}

// The last 10 digits of a phone number, with any separators between them. Matches every way it is written.
function phoneCoreRe(phone: string): RegExp {
  const core = phone.replace(/\D/g, '').slice(-10);
  return new RegExp(core.split('').join('[\\s().-]*'), 'g');
}

export function nameTokens(name: string | null): string[] {
  if (!name) return [];
  return name.split(/\s+/).map((t) => t.replace(/[.'’]/g, '')).filter((t) => t.length >= 2);
}

// "07_aditya_nair.pdf" / "pm_07_Aditya-Nair CV.docx" -> "Aditya Nair".
export function nameFromFileName(fileName: string): string | null {
  const words = fileName
    .replace(/\.[a-z0-9]+$/i, '')
    .split(/[\s_\-.]+/)
    .filter((w) => w && !/^\d+$/.test(w) && !/^(s?pm|cv|resume|résumé|final|updated|new|copy|\(\d+\))$/i.test(w));
  if (words.length < 2 || words.length > 4 || !words.every((w) => /^[A-Za-z'’]+$/.test(w))) return null;
  return tidyName(words.join(' '));
}

export function extractPII(raw: string, fileName?: string): { pii: PII; redacted: string; nameSource: NameSource } {
  const text = unglue(raw.replace(/\r\n?/g, '\n'));
  const emails = text.match(EMAIL_RE) ?? [];
  // A run that is too long to be one number may be the same number repeated: look for numbers inside it.
  const PHONE_IN_RUN = /(?:\+\d{1,3}[\s-]?)?\d{5}[\s-]?\d{5}|(?:\+\d{1,3}[\s-]?)?\d{3}[\s-]?\d{3}[\s-]?\d{4}/g;
  const phones = (text.match(PHONE_RE) ?? []).flatMap((m) => (isPhone(m) ? [m] : (m.match(PHONE_IN_RUN) ?? []).filter(isPhone)));
  const email = emails[0] ?? null;
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);

  // Order of trust: a name in the CV text; the file name's name only when the text has none.
  const fileGuess = fileName ? nameFromFileName(fileName) : null;
  const fileGuessInText = fileGuess && new RegExp(`\\b${fileGuess.split(' ').map(escapeRe).join('\\s+')}\\b`, 'i').test(text);
  const fromCv = fileGuessInText ? fileGuess : findName(text, lines, (email ?? '').split('@')[0].toLowerCase());
  const local = email?.split('@')[0];
  const fromEmail = !fromCv && !fileGuess && local && /^[a-z]{2,}[._-][a-z]{2,}$/i.test(local) ? tidyName(local.replace(/[._-]/g, ' ')) : null;
  const name = fromCv ?? fileGuess ?? fromEmail;
  const nameSource: NameSource = fromCv ? 'cv' : fileGuess ? 'file' : null;

  let redacted = text.replace(EMAIL_RE, '[email removed]').replace(URL_RE, '[link removed]');
  for (const p of phones) redacted = redacted.split(p).join('[phone removed]');
  // Also catch the same number written again in any other way (repeated, no spaces, no country code).
  for (const p of phones) redacted = redacted.replace(phoneCoreRe(p), '[phone removed]');
  if (name) {
    redacted = redacted.replace(new RegExp(escapeRe(name), 'gi'), '[name removed]');
    for (const t of nameTokens(name)) redacted = redacted.replace(new RegExp(`\\b${escapeRe(t)}\\b`, 'gi'), '[name removed]');
    // Names joined into one word, as in handles: "pranavjoshi", "joshipranav".
    const toks = nameTokens(name).filter((t) => t.length >= 3);
    if (toks.length >= 2) redacted = redacted.replace(new RegExp(`(${toks.map(escapeRe).join('|')}){2,}`, 'gi'), '[name removed]');
  } else {
    // Couldn't identify the name: drop the header line, which is where a name almost always sits.
    const first = redacted.split('\n').find((l) => l.trim());
    if (first && first.trim().split(/\s+/).length <= 6 && !/\d/.test(first)) redacted = redacted.replace(first, '[header removed]');
  }
  redacted = redacted.replace(/(\[name removed\][\s-]*){2,}/g, '[name removed] ').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();

  return { pii: { name, email, phone: phones[0]?.trim() ?? null }, redacted, nameSource };
}

// Last line of defence: called right before every AI request. Throws rather than leak.
export function assertNoPII(text: string, pii: PII): void {
  const lower = text.toLowerCase();
  if (pii.email && lower.includes(pii.email.toLowerCase())) throw new Error('PII guard: email found in text bound for AI');
  if (/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/.test(text)) throw new Error('PII guard: an email address is present in text bound for AI');
  if (pii.phone && phoneCoreRe(pii.phone).test(text)) throw new Error('PII guard: phone number found in text bound for AI');
  const toks = nameTokens(pii.name).filter((t) => t.length >= 3);
  for (const t of toks) {
    if (new RegExp(`\\b${escapeRe(t)}\\b`, 'i').test(text)) throw new Error('PII guard: candidate name found in text bound for AI');
  }
  if (toks.length >= 2 && lower.includes(toks.map((t) => t.toLowerCase()).join(''))) throw new Error('PII guard: candidate name (joined) found in text bound for AI');
}

export const firstName = (name: string | null) => (name ? name.trim().split(/\s+/)[0] : null);
