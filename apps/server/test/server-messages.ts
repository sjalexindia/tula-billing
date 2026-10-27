import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Every English sentence the server can put in front of a person, read from the source as
 * templates: `Item code ${b.sku} is already used` → "Item code {{sku}} is already used".
 * The web shows them in the person's language through apps/web/src/locales/<lang>/server.json
 * (apps/web/src/server-text.ts); test/i18n.test.ts checks that every template has a translation,
 * so a new or changed message cannot slip through in English.
 *
 * Sources: UserError / RangeError / SyncError, `message:` (warnings, cancel blockers), settings
 * consistency issues, validation messages in zod `.refine/.regex/.min/.max`, and the phrases in
 * report rows and ledger narrations (GSTR-3B sections, "… against …").
 */
const SRC = join(__dirname, '..', 'src');
const CORE = join(__dirname, '..', '..', '..', 'packages', 'core', 'src');

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) return f === 'cli' ? [] : files(p);
    return p.endsWith('.ts') ? [p] : [];
  });
}

const LIT = String.raw`('(?:[^'\\]|\\.)*'|\`(?:[^\`\\]|\\.)*\`)`;

/** Name for a ${…} placeholder: the last identifier in the expression (b.sku → sku); a plural "s" → s. */
export function placeholder(expr: string): string {
  if (/\?/.test(expr) && /'s'/.test(expr)) return 's';
  const skip = new Set(['String', 'Number', 'toFixed', 'join', 'map', 'length', 'slice', 'trim', 'toUpperCase', 'JSON', 'stringify', 'Math', 'round', 'ceil', 'floor', 'abs']);
  const ids = (expr.match(/[A-Za-z_][A-Za-z0-9_]*/g) ?? []).filter((i) => !skip.has(i));
  return ids[ids.length - 1] ?? 'x';
}

export function toTemplate(literal: string): string {
  return literal.replace(/\$\{([^{}]*(?:\{[^{}]*\}[^{}]*)*)\}/g, (_m, e: string) => `{{${placeholder(e)}}}`);
}

const PATTERNS = [
  new RegExp(String.raw`new (?:UserError|RangeError|SyncError)\(\s*(?:'[A-Z_]+',\s*)?${LIT}`, 'g'),
  new RegExp(String.raw`\bmessage: ${LIT}`, 'g'),
  new RegExp(String.raw`\bissues\.push\(${LIT}`, 'g'),
  new RegExp(String.raw`\b(?:narration|nature|detail|desc|description): ${LIT}`, 'g'),
];
/** validation messages: the string argument closing a zod check */
const ZOD_LINE = /\.(?:refine|regex|min|max|length|int|positive|nonnegative)\(/;
const ZOD_MSG = new RegExp(String.raw`[,(]\s*${LIT}\s*\)`, 'g');

/** Words outside the placeholders: "{{docNo}} ({{supplierBillNo}})" is not a sentence to translate. */
const sentence = (t: string) => {
  const words = t.replace(/\{\{[^}]+\}\}/g, ' ');
  return /[a-z]{2}/.test(words) && /\s/.test(t.trim()) && !/^[a-z_.]+$/.test(t);
};

/** Messages zod itself writes (zod v4), as templates; the web translates them too. */
export const ZOD_MESSAGES = [
  'Invalid input: expected {{expected}}, received {{received}}',
  'Invalid input',
  'Too small: expected string to have >={{n}} characters',
  'Too big: expected string to have <={{n}} characters',
  'Too small: expected number to be >={{n}}',
  'Too small: expected number to be >{{n}}',
  'Too big: expected number to be <={{n}}',
  'Too big: expected number to be <{{n}}',
  'Too small: expected array to have >={{n}} items',
  'Too big: expected array to have <={{n}} items',
  'Invalid option: expected one of {{options}}',
  'Invalid string: must match pattern {{pattern}}',
];

export function serverMessages(): Map<string, string> {
  const out = new Map<string, string>();
  const add = (lit: string, f: string) => {
    const body = lit.slice(1, -1).replace(/\\'/g, "'").replace(/\\\\/g, '\\');
    const t = toTemplate(body);
    if (!sentence(t)) return;
    if (!out.has(t)) out.set(t, f.slice(f.lastIndexOf('src')));
  };
  for (const f of [...files(SRC), ...files(CORE)]) {
    const src = readFileSync(f, 'utf8');
    for (const re of PATTERNS) for (const m of src.matchAll(re)) add(m[1]!, f);
    for (const line of src.split('\n')) {
      if (ZOD_LINE.test(line)) for (const m of line.matchAll(ZOD_MSG)) add(m[1]!, f);
    }
  }
  return out;
}
