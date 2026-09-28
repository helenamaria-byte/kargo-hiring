// Parses rubric/rubric.txt into rubric_criteria rows. Throws loudly on anything unexpected.
// Plain JS so the seed script and the tests can both import it without a build step.

const SECTIONS = [
  { role: 'PM', start: /STEP 2 — PRODUCT MANAGER RUBRIC/, end: /STEP 3 — SENIOR PRODUCT MANAGER RUBRIC/ },
  { role: 'SPM', start: /STEP 3 — SENIOR PRODUCT MANAGER RUBRIC/, end: /CALIBRATION CHECK/ },
];

const squash = (s) => s.replace(/\s+/g, ' ').trim();

function parseSection(text, role) {
  const blocks = text.split(/^Criterion name:/m).slice(1);
  return blocks.map((block, i) => {
    const name = squash(block.split('\n')[0]);
    const desc = block.match(/What a strong candidate looks like:([\s\S]*?)(?=^Source:|^Weight:)/m);
    const weight = block.match(/^Weight:\s*(\d+)\s*%/m);
    if (!name) throw new Error(`rubric.txt: ${role} criterion ${i + 1} has no name`);
    if (!desc) throw new Error(`rubric.txt: ${role} "${name}" has no "What a strong candidate looks like"`);
    if (!weight) throw new Error(`rubric.txt: ${role} "${name}" has no "Weight: N%" line`);
    return { role, position: i + 1, name, description: squash(desc[1]), weight: Number(weight[1]) };
  });
}

export function parseRubric(text) {
  const byRole = {};
  for (const s of SECTIONS) {
    const a = text.search(s.start);
    const b = text.search(s.end);
    if (a < 0 || b < 0 || b < a) throw new Error(`rubric.txt: could not find the ${s.role} section`);
    byRole[s.role] = parseSection(text.slice(a, b), s.role);
  }

  // SPM = "same five criteria, higher bar". Most SPM text says "As for PM, and ..." — so every SPM
  // row carries the PM baseline (incl. its 1/3/5 scale) followed by the SPM bar, and stands on its own.
  for (const c of byRole.SPM) {
    const pm = byRole.PM.find((p) => p.name === c.name);
    if (!pm) throw new Error(`rubric.txt: SPM "${c.name}" has no PM criterion with the same name`);
    c.description = `PM BASELINE: ${pm.description} SENIOR PRODUCT MANAGER BAR (this overrides the baseline where they differ): ${c.description}`;
  }

  validateRubric([...byRole.PM, ...byRole.SPM]);
  return [...byRole.PM, ...byRole.SPM];
}

// Shared check, also used at runtime against what is actually in the database.
export function validateRubric(rows) {
  const problems = [];
  for (const role of ['PM', 'SPM']) {
    const r = rows.filter((x) => x.role === role);
    const total = r.reduce((s, x) => s + x.weight, 0);
    if (r.length !== 5) problems.push(`${role} has ${r.length} criteria, expected 5`);
    if (total !== 100) problems.push(`${role} weights sum to ${total}, must be exactly 100 (${r.map((x) => `${x.name}=${x.weight}`).join(', ')})`);
    for (const x of r) {
      if (!Number.isInteger(x.weight) || x.weight <= 0) problems.push(`${role} "${x.name}" has invalid weight ${x.weight}`);
      if (!x.description || x.description.length < 40) problems.push(`${role} "${x.name}" has a missing or too-short description`);
    }
  }
  if (problems.length) throw new Error(`RUBRIC INVALID — refusing to score:\n  - ${problems.join('\n  - ')}`);
}
