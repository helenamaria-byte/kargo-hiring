export type RubricRow = { role: 'PM' | 'SPM'; position: number; name: string; description: string; weight: number };
export function parseRubric(text: string): RubricRow[];
export function validateRubric(rows: { role: string; name: string; description: string; weight: number }[]): void;
