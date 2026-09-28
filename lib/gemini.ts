import { GoogleGenAI, type Schema } from '@google/genai';
import { env } from './config';
import { assertNoPII, type PII } from './pii';

let ai: GoogleGenAI | null = null;
const model = () => process.env.GEMINI_MODEL || 'gemini-flash-latest';

// Every AI call in the app goes through here, and every one is checked for PII first.
export async function generateJSON<T>(opts: {
  system: string;
  prompt: string;
  schema: Schema;
  pii: PII;
}): Promise<T> {
  // The system prompt is static rubric text; the prompt carries all candidate-derived text.
  assertNoPII(opts.prompt, opts.pii);
  ai ??= new GoogleGenAI({ apiKey: env('GEMINI_API_KEY') });

  let lastErr: unknown;
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const res = await ai.models.generateContent({
        model: model(),
        contents: opts.prompt,
        config: { systemInstruction: opts.system, responseMimeType: 'application/json', responseSchema: opts.schema },
      });
      const text = res.text;
      if (!text) throw new Error(`Gemini returned no text (finish reason: ${res.candidates?.[0]?.finishReason ?? 'unknown'})`);
      return JSON.parse(text) as T;
    } catch (e) {
      lastErr = e;
      const status = (e as { status?: number }).status;
      const retryable = status === undefined || status === 429 || status >= 500 || e instanceof SyntaxError;
      if (!retryable) break;
      await new Promise((r) => setTimeout(r, Math.min(30_000, 2_000 * 2 ** attempt) + Math.random() * 1000));
    }
  }
  throw new Error(`Gemini (${model()}) failed: ${lastErr instanceof Error ? lastErr.message : String(lastErr)}`);
}
