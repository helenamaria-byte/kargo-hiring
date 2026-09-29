// Step 1: pull name, email and phone out of the raw CV text — in code, with no AI call,
// so personal details never leave this server. Everything downstream only sees `redacted`.

export type PII = { name: string | null; email: string | null; phone: string | null };

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const PHONE_RE = /(?:\+?\d[\d\s().-]{7,}\d)/g;
const PROFILE_URL_RE = /(?:https?:\/\/)?(?:www\.)?(?:linkedin\.com|github\.com|twitter\.com|x\.com|instagram\.com|facebook\.com)\/[^\s,;|)]*/gi;
const NOT_A_NAME = /\b(university|college|institute|school|academy|iit|iim|imt|nit|bits|iiit|xlri|isb|resume|résumé|curriculum|vitae|cv|profile|summary|contact|objective|experience|education|skills|address|email|phone|mobile|product|manager|engineer|senior|operations|linkedin)\b/i;

function isPhone(candidate: string): boolean {
  const digits = candidate.replace(/\D/g, '');
  if (digits.length < 10 || digits.length > 13) return false;
  // "2015-2019 2019-2021" is two date ranges, not a phone number.
  const groups = candidate.split(/[^\d]+/).filter(Boolean);
  if (groups.every((g) => /^(19|20)\d{2}$/.test(g))) return false;
  return true;
}

function findName(lines: string[], email: string | null): string | null {
  const head = lines.slice(0, 15);
  for (const line of head) {
    const m = line.match(/^\s*(?:full\s+)?name\s*[:\-–]\s*(.+)$/i);
    if (m) return tidyName(m[1]);
  }
  for (const line of head.slice(0, 8)) {
    const t = line.replace(/[|•·,].*$/, '').trim(); // "Rohan Desai | Mumbai" -> "Rohan Desai"
    if (!t || t.length > 40 || /[@\d]/.test(t) || NOT_A_NAME.test(t)) continue;
    const words = t.split(/\s+/);
    if (words.length < 2 || words.length > 4) continue;
    if (words.every((w) => /^[A-Z][A-Za-z'’.-]*$/.test(w) || /^[A-Z][A-Z'’.-]+$/.test(w))) return tidyName(t);
  }
  // Fallback: rohan.desai@x.com -> Rohan Desai
  const local = email?.split('@')[0];
  if (local && /^[a-z]{2,}[._-][a-z]{2,}$/i.test(local)) return tidyName(local.replace(/[._-]/g, ' '));
  return null;
}

function tidyName(s: string): string {
  return s
    .trim()
    .split(/\s+/)
    .map((w) => (w === w.toUpperCase() || w === w.toLowerCase() ? w[0].toUpperCase() + w.slice(1).toLowerCase() : w))
    .join(' ');
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function nameTokens(name: string | null): string[] {
  if (!name) return [];
  return name.split(/\s+/).map((t) => t.replace(/[.'’]/g, '')).filter((t) => t.length >= 2);
}

// "07_aditya_nair.pdf" / "pm_07_Aditya-Nair CV.docx" -> "Aditya Nair". Used only when the CV text has no name.
export function nameFromFileName(fileName: string): string | null {
  const words = fileName
    .replace(/\.[a-z0-9]+$/i, '')
    .split(/[\s_\-.]+/)
    .filter((w) => w && !/^\d+$/.test(w) && !/^(s?pm|cv|resume|résumé|final|updated|new|copy|\(\d+\))$/i.test(w));
  if (words.length < 2 || words.length > 4 || !words.every((w) => /^[A-Za-z'’]+$/.test(w))) return null;
  return tidyName(words.join(' '));
}

export function extractPII(raw: string, fileName?: string): { pii: PII; redacted: string; nameSource: 'cv' | 'file' | null } {
  const text = raw.replace(/\r\n?/g, '\n');
  const emails = text.match(EMAIL_RE) ?? [];
  const phones = (text.match(PHONE_RE) ?? []).filter(isPhone);
  const email = emails[0] ?? null;
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  // Order of trust: a labelled "Name:" line, then a proper name in the file name (people name CV files
  // after the candidate), then the first name-like line in the CV, then a guess from the email address.
  const labelled = lines.slice(0, 15).map((l) => l.match(/^\s*(?:full\s+)?name\s*[:\-–]\s*(.+)$/i)?.[1]).find(Boolean);
  const fromFile = !labelled && fileName ? nameFromFileName(fileName) : null;
  const fromCv = labelled ? tidyName(labelled) : fromFile ? null : findName(lines, null);
  const name = fromCv ?? fromFile ?? findName([], email);

  let redacted = text
    .replace(EMAIL_RE, '[email removed]')
    .replace(PROFILE_URL_RE, '[profile link removed]');
  for (const p of phones) redacted = redacted.split(p).join('[phone removed]');
  if (name) {
    redacted = redacted.replace(new RegExp(escapeRe(name), 'gi'), '[name removed]');
    for (const t of nameTokens(name)) redacted = redacted.replace(new RegExp(`\\b${escapeRe(t)}\\b`, 'gi'), '[name removed]');
  } else {
    // Couldn't identify the name: drop the header line, which is where a name almost always sits.
    const first = redacted.split('\n').find((l) => l.trim());
    if (first && first.trim().split(/\s+/).length <= 6 && !/\d/.test(first)) redacted = redacted.replace(first, '[header removed]');
  }
  redacted = redacted.replace(/(\[name removed\]\s*){2,}/g, '[name removed] ').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();

  return { pii: { name, email, phone: phones[0]?.trim() ?? null }, redacted, nameSource: fromCv ? 'cv' : fromFile ? 'file' : null };
}

// Last line of defence: called right before every AI request. Throws rather than leak.
export function assertNoPII(text: string, pii: PII): void {
  const lower = text.toLowerCase();
  if (pii.email && lower.includes(pii.email.toLowerCase())) throw new Error('PII guard: email found in text bound for AI');
  if (/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/.test(text)) throw new Error('PII guard: an email address is present in text bound for AI');
  if (pii.phone) {
    const digits = pii.phone.replace(/\D/g, '');
    const flexible = new RegExp(digits.split('').join('[\\s().-]*'));
    if (flexible.test(text)) throw new Error('PII guard: phone number found in text bound for AI');
  }
  for (const t of nameTokens(pii.name)) {
    if (t.length >= 3 && new RegExp(`\\b${escapeRe(t)}\\b`, 'i').test(text)) throw new Error('PII guard: candidate name found in text bound for AI');
  }
}

export const firstName = (name: string | null) => (name ? name.trim().split(/\s+/)[0] : null);
