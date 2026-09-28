// Text in a CV that addresses the AI/screener. Detected lines are flagged on the card and
// stripped from what the scorer sees; the model is also told to report anything else it spots.

const PATTERNS: RegExp[] = [
  /\b(ignore|disregard|forget|override)\b.{0,40}\b(instructions?|prompts?|rules|rubric|directions)\b/i,
  /\b(you are|you're|act as)\b.{0,20}\b(an? )?(ai|a\.i\.|language model|llm|chatgpt|gpt|gemini|claude|assistant|bot)\b/i,
  /\b(system|developer)\s+prompt\b/i,
  /\bnew instructions\b/i,
  /\b(note|message|instructions?)\s+(to|for)\s+(the\s+)?(ai|llm|model|chatgpt|gemini|bot|screener|screening (tool|system|software)|ats)\b/i,
  /\b(dear|attention|hey|hello)\s+(ai|llm|chatgpt|gemini|bot|screening (tool|system|software)|ats)\b/i,
  /\b(score|rate|rank|grade|mark)\s+(me|this (candidate|cv|resume|applicant))\b.{0,30}\b(5|five|highest|top|perfect|100|maximum|max)\b/i,
  /\b(give|assign)\s+(me|this (candidate|cv|resume|applicant))\b.{0,20}\b(5|five|highest|top|perfect|full|maximum)\b/i,
  /\b(recommend|shortlist|select)\s+(me|this (candidate|applicant))\b.{0,30}\b(interview|hire|hiring)\b/i,
];

export function detectInjection(text: string): { lines: string[]; cleaned: string } {
  const lines: string[] = [];
  const cleaned = text
    .split('\n')
    .map((line) => {
      if (PATTERNS.some((p) => p.test(line))) {
        lines.push(line.trim().slice(0, 200));
        return '[text addressed to the screening system removed]';
      }
      return line;
    })
    .join('\n');
  return { lines, cleaned };
}
