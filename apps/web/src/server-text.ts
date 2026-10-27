import { formatQty, formatRs } from '@tula/core';
import i18n from 'i18next';
import type { CatalogItem, Warning } from './api';
import { nameIn, RESOURCES } from './i18n';

/*
 * Server messages in the person's language. The server writes plain English sentences (errors,
 * validation messages, ledger narrations, GST row descriptions); the English sentence is the key,
 * as in gettext. locales/<lang>/server.json maps each English template to a translation:
 *   "Item code {{sku}} is already used": "பொருள் குறியீடு {{sku}} ஏற்கனவே பயன்பாட்டில் உள்ளது"
 * A message with no translation stays in English. apps/server/test/i18n.test.ts reads the server's
 * source and fails when a message has no Tamil template, so new messages cannot slip through.
 */

interface Entry { re: RegExp; names: string[]; out: string }
type Catalog = Record<string, string>;

const compiled = new Map<string, Entry[]>();
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function compile(cat: Catalog | undefined): Entry[] {
  return Object.entries(cat ?? {}).map(([en, out]) => {
    const names: string[] = [];
    const src = en.split(/(\{\{\w+\}\})/).map((part) => {
      const m = /^\{\{(\w+)\}\}$/.exec(part);
      if (!m) return escape(part);
      names.push(m[1]!);
      return '([\\s\\S]*?)';
    }).join('');
    return { re: new RegExp(`^${src}$`), names, out };
  })
    // the most specific template first: more fixed text wins over a looser one
    .sort((a, b) => b.re.source.replace(/\(\[\\s\\S\]\*\?\)/g, '').length - a.re.source.replace(/\(\[\\s\\S\]\*\?\)/g, '').length);
}

function catalog(lang: string, which: 'serverText' | 'serverTextZod'): Entry[] {
  const k = `${lang}:${which}`;
  let c = compiled.get(k);
  if (!c) {
    const tree = (RESOURCES as Record<string, { translation: Record<string, unknown> }>)[lang]?.translation;
    c = compile(tree?.[which] as Catalog | undefined);
    compiled.set(k, c);
  }
  return c;
}

/** Values inside a message: setting keys get their screen label; other values are translated if they are messages themselves. */
function value(name: string, v: string, lang: string, depth: number): string {
  if (name === 'key' && i18n.exists(`settings.keys.${v}`, { lng: lang })) return i18n.t(`settings.keys.${v}`, { lng: lang });
  return serverText(v, lang, depth + 1);
}

function apply(entries: Entry[], text: string, lang: string, depth: number): string | null {
  for (const e of entries) {
    const m = e.re.exec(text);
    if (!m) continue;
    const params = Object.fromEntries(e.names.map((n, i) => [n, value(n, m[i + 1]!, lang, depth)]));
    return e.out.replace(/\{\{(\w+)\}\}/g, (_x, n: string) => params[n] ?? '');
  }
  return null;
}

/** One server sentence in `lang` (the current language by default); unchanged when there is no translation. */
export function serverText(text: string, lang = i18n.language, depth = 0): string {
  if (!text || depth > 3) return text;
  return apply(catalog(lang, 'serverText'), text, lang, depth) ?? apply(catalog(lang, 'serverTextZod'), text, lang, depth) ?? text;
}

/**
 * An error the API returned. Validation errors come as "field: message; field: message": a message
 * the app wrote already says what is wrong; zod's own wording gets the field's name in front.
 */
export function errorText(code: string | undefined, message: string, lang = i18n.language): string {
  if (code !== 'VALIDATION') return serverText(message, lang);
  return message.split('; ').map((part) => {
    const i = part.indexOf(': ');
    if (i < 0) return serverText(part, lang);
    const field = part.slice(0, i).split('.')[0]!;
    const msg = part.slice(i + 2);
    const own = apply(catalog(lang, 'serverText'), msg, lang, 0);
    if (own !== null) return own;
    const generic = apply(catalog(lang, 'serverTextZod'), msg, lang, 0) ?? msg;
    const label = i18n.exists(`msg.fields.${field}`, { lng: lang }) ? i18n.t(`msg.fields.${field}`, { lng: lang }) : field;
    return `${label}: ${generic}`;
  }).join('; ');
}

/**
 * A bill or purchase warning in the person's language, written from its code and values; the
 * product's name and unit come from the catalog when it is at hand. Falls back to the English message.
 */
export function warningText(w: Warning, catalog: CatalogItem[] = [], lang = i18n.language): string {
  const p = w.params ?? {};
  const item = catalog.find((c) => c.id === w.productId);
  const name = item ? nameIn(lang, item.nameEn, item.nameTa) : nameIn(lang, String(p.name_en ?? ''), p.name_ta ? String(p.name_ta) : null);
  const unit = item ? nameIn(lang, item.baseUnitEn, item.baseUnitTa) : '';
  const qty = (milli: unknown) => formatQty(Number(milli), { trimZeros: true });
  const t = (key: string, opts: Record<string, unknown>) => i18n.t(`msg.warn.${key}`, { lng: lang, ...opts });
  if (w.code === 'LOW_STOCK' && p.billingMilli !== undefined) return t('LOW_STOCK', { name, unit, billing: qty(p.billingMilli), stock: qty(p.stockMilli) });
  if (w.code === 'LOW_STOCK' && p.afterMilli !== undefined) return t('LOW_STOCK_AFTER_CANCEL', { name, after: qty(p.afterMilli) });
  if (w.code === 'CREDIT_LIMIT' && p.limitPaise !== undefined) return t('CREDIT_LIMIT', { outstanding: formatRs(Number(p.outstandingPaise)), limit: formatRs(Number(p.limitPaise)) });
  if (w.code === 'RATE_MISSING' && p.group !== undefined) return t('RATE_MISSING', { group: p.group });
  if (w.code === 'EWAY' && p.thresholdPaise !== undefined) return t('EWAY', { threshold: formatRs(Number(p.thresholdPaise)) });
  return serverText(w.message, lang);
}
