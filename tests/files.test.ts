import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileToText } from '../lib/parse-file.ts';
import { extractPII, assertNoPII } from '../lib/pii.ts';
import { detectInjection } from '../lib/injection.ts';
import { contentHash, findDuplicate } from '../lib/dedupe.ts';

const load = async (f: string) => {
  const b = readFileSync(`tests/fixtures/${f}`);
  return extractPII(await fileToText(f, b.buffer.slice(b.byteOffset, b.byteOffset + b.length) as ArrayBuffer));
};

test('PDF and DOCX: parsed, PII removed, injection caught, same CV under another name flagged', async () => {
  const pdf = await load('meghna.pdf');
  const docx = await load('priya.docx');
  assert.deepEqual(pdf.pii, { name: 'Meghna Tiwari', email: 'meghna.t@example.com', phone: '+91 98200 12345' });
  assert.deepEqual(docx.pii, { name: 'Priya Menon', email: 'priya.m@example.com', phone: '+91 98200 12345' });
  for (const { pii, redacted } of [pdf, docx]) {
    assert.doesNotThrow(() => assertNoPII(redacted, pii));
    assert.match(redacted, /200\+ shipments/);
    assert.equal(detectInjection(redacted).lines.length, 1);
  }
  const dup = findDuplicate(docx.redacted, contentHash(docx.redacted), [{ id: 1, cv_content: pdf.redacted, content_hash: contentHash(pdf.redacted) }]);
  assert.equal(dup?.id, 1);
});
