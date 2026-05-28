'use strict';

/**
 * Lithuanian diacritics → ASCII map. Used for stub email generation in the
 * seed migration. Matches the canonical AM @am.lt convention: "Vardas
 * Pavardė" → "vardas.pavarde@am.lt".
 */
const DIACRITICS: Record<string, string> = {
  ą: 'a', č: 'c', ę: 'e', ė: 'e', į: 'i', š: 's', ų: 'u', ū: 'u', ž: 'z',
  Ą: 'A', Č: 'C', Ę: 'E', Ė: 'E', Į: 'I', Š: 'S', Ų: 'U', Ū: 'U', Ž: 'Z',
};

function stripDiacritics(s: string): string {
  return s.split('').map((c) => DIACRITICS[c] ?? c).join('');
}

/**
 * Converts a display name like `Aušra Krušna` to the corresponding @am.lt
 * email: `ausra.krusna@am.lt`.
 *
 * Rules:
 *   - Diacritics → ASCII
 *   - Parenthesised aliases stripped (`Aistė Semėnė (Gadliauskaitė)` → `aiste.semene`)
 *   - First token + last token joined with `.` (handles middle names)
 *   - Hyphenated surnames kept intact (`Burneikaitė-Raugalienė` → `burneikaite-raugaliene`)
 *   - Lowercased
 *   - Domain `@am.lt`
 */
export function nameToEmail(fullName: string): string {
  const ascii = stripDiacritics(fullName);
  const noParens = ascii.replace(/\s*\(.*?\)\s*/g, ' ').trim();
  const tokens = noParens.split(/\s+/).filter(Boolean);
  if (tokens.length === 0) throw new Error(`Empty name: ${fullName}`);
  const first = tokens[0].toLowerCase();
  const last = tokens[tokens.length - 1].toLowerCase();
  if (tokens.length === 1) {
    return `${first}@am.lt`;
  }
  return `${first}.${last}@am.lt`;
}
