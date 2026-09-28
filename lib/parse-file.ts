import mammoth from 'mammoth';
import { extractText as pdfText, getDocumentProxy } from 'unpdf';

export async function fileToText(name: string, buf: ArrayBuffer): Promise<string> {
  const ext = name.toLowerCase().split('.').pop();
  let text: string;
  if (ext === 'pdf') {
    const pdf = await getDocumentProxy(new Uint8Array(buf));
    const out = await pdfText(pdf, { mergePages: true });
    text = Array.isArray(out.text) ? out.text.join('\n') : out.text;
  } else if (ext === 'docx') {
    text = (await mammoth.extractRawText({ buffer: Buffer.from(buf) })).value;
  } else {
    throw new Error(`Unsupported file type ".${ext}" — upload PDF or DOCX`);
  }
  text = text.replace(/\u0000/g, '').replace(/[ \t]+/g, ' ').replace(/\n\s*\n\s*\n+/g, '\n\n').trim();
  if (text.length < 200) throw new Error('Almost no text could be read from this file — it may be a scanned image. Ask for a text PDF or DOCX.');
  return text;
}
