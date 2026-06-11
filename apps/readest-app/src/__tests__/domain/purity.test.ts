// src/__tests__/domain/purity.test.ts
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const DOMAIN_DIR = join(process.cwd(), 'src/domain');
const FORBIDDEN = [
  /from\s+['"]@\/services\b/,
  /from\s+['"]@\/store\b/,
  /from\s+['"]@\/styles\b/,
  /from\s+['"]@\/hooks\b/,
  /from\s+['"]@\/components\b/,
  /from\s+['"]@\/app\b/,
  /from\s+['"]@\/context\b/,
  /from\s+['"]@\/utils\b/,
  /from\s+['"]@\/libs\b/,
];

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (p.endsWith('.ts') || p.endsWith('.tsx')) out.push(p);
  }
  return out;
}

describe('domain layer purity', () => {
  it('does not import from runtime modules', () => {
    const offenders: string[] = [];
    for (const file of walk(DOMAIN_DIR)) {
      const src = readFileSync(file, 'utf8');
      for (const re of FORBIDDEN) {
        if (re.test(src)) offenders.push(`${file} :: ${re}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
