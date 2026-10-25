/**
 * The settings registry: every business-specific value lives here as data,
 * never in code. Unknown keys are rejected; each key has a type and default.
 */
import { stateFromGstin } from './gst';
import { parseScaled } from './money';
import { DEFAULT_DOC_FORMAT, DOC_NO_MAX, formatDocNo, validateDocFormat } from './numbering';
import { STATES } from './states';

type Kind =
  | { type: 'text'; max?: number }
  | { type: 'enum'; values: readonly string[] }
  | { type: 'bool' }
  | { type: 'state' }
  | { type: 'gstin' }
  | { type: 'langs' }
  | { type: 'lang' }
  | { type: 'docPrefix' }
  | { type: 'docFormat' }
  | { type: 'int'; min: number; max: number }
  | { type: 'amount' }
  | { type: 'percent'; max: number };

export interface SettingDef {
  kind: Kind;
  default: string;
  /** must be filled before the first bill can be saved */
  requiredForBilling?: boolean;
  /** owner-only to change (all settings are owner-only in Release 1, kept for later roles) */
  group: 'business' | 'gst' | 'invoice' | 'billing' | 'eway' | 'credit' | 'app';
}

/** Languages the app ships translations for. Add a locale file and an entry here to add one. */
export const SUPPORTED_LANGS = ['en', 'ta'] as const;
export type LangCode = (typeof SUPPORTED_LANGS)[number];

export const SETTINGS = {
  // ---- Business identity (printed on every invoice)
  'business.name_en': { kind: { type: 'text', max: 80 }, default: '', requiredForBilling: true, group: 'business' },
  'business.name_ta': { kind: { type: 'text', max: 80 }, default: '', group: 'business' },
  'business.legal_name': { kind: { type: 'text', max: 100 }, default: '', group: 'business' },
  'business.tagline': { kind: { type: 'text', max: 120 }, default: '', group: 'business' },
  'business.address': { kind: { type: 'text', max: 300 }, default: '', requiredForBilling: true, group: 'business' },
  'business.phone': { kind: { type: 'text', max: 40 }, default: '', group: 'business' },
  'business.email': { kind: { type: 'text', max: 120 }, default: '', group: 'business' },
  'business.state_code': { kind: { type: 'state' }, default: '', requiredForBilling: true, group: 'business' },
  'business.upi_id': { kind: { type: 'text', max: 80 }, default: '', group: 'business' },
  'business.bank_details': { kind: { type: 'text', max: 200 }, default: '', group: 'business' },

  // ---- GST
  'gst.scheme': { kind: { type: 'enum', values: ['regular', 'composition', 'unregistered'] }, default: 'regular', group: 'gst' },
  'gst.gstin': { kind: { type: 'gstin' }, default: '', group: 'gst' },

  // ---- Invoice
  'invoice.default_lang': { kind: { type: 'lang' }, default: 'en', group: 'invoice' },
  'invoice.terms_en': { kind: { type: 'text', max: 600 }, default: 'Goods once sold will not be taken back. Subject to local jurisdiction.', group: 'invoice' },
  'invoice.terms_ta': { kind: { type: 'text', max: 600 }, default: 'விற்ற பொருள் திரும்பப் பெறப்படாது. உள்ளூர் நீதிமன்ற அதிகார வரம்புக்கு உட்பட்டது.', group: 'invoice' },
  'invoice.show_upi_qr': { kind: { type: 'bool' }, default: 'true', group: 'invoice' },
  'invoice.paper': { kind: { type: 'enum', values: ['A4', 'A5'] }, default: 'A4', group: 'invoice' },
  'invoice.label_mode': { kind: { type: 'enum', values: ['single', 'bilingual'] }, default: 'single', group: 'invoice' },
  'invoice.prefix': { kind: { type: 'docPrefix' }, default: 'INV', group: 'invoice' },
  'invoice.number_format': { kind: { type: 'docFormat' }, default: DEFAULT_DOC_FORMAT, group: 'invoice' },
  'invoice.seq_digits': { kind: { type: 'int', min: 1, max: 8 }, default: '4', group: 'invoice' },
  /** first running number for the current financial year, e.g. to continue a paper bill book */
  'invoice.start_number': { kind: { type: 'int', min: 1, max: 99_999_999 }, default: '1', group: 'invoice' },

  // ---- Billing rules
  'billing.stock_check': { kind: { type: 'enum', values: ['warn', 'block', 'off'] }, default: 'warn', group: 'billing' },
  'billing.credit_check': { kind: { type: 'enum', values: ['warn', 'block', 'off'] }, default: 'warn', group: 'billing' },
  /** rates (master, daily and typed on the bill) already include GST; the bill back-calculates the taxable value */
  'billing.rates_include_gst': { kind: { type: 'bool' }, default: 'false', group: 'billing' },

  // ---- E-way bill reminders (thresholds differ by state; inter-state is ₹50,000 nationally)
  'eway.warn': { kind: { type: 'bool' }, default: 'true', group: 'eway' },
  'eway.threshold_intra': { kind: { type: 'amount' }, default: '50000', group: 'eway' },
  'eway.threshold_inter': { kind: { type: 'amount' }, default: '50000', group: 'eway' },

  // ---- Credit
  'credit.default_days': { kind: { type: 'int', min: 0, max: 365 }, default: '0', group: 'credit' },
  'credit.interest_pa': { kind: { type: 'percent', max: 36 }, default: '0', group: 'credit' },

  // ---- App
  'app.languages': { kind: { type: 'langs' }, default: 'en', group: 'app' },
  'app.default_lang': { kind: { type: 'lang' }, default: 'en', group: 'app' },
} as const satisfies Record<string, SettingDef>;

export type SettingKey = keyof typeof SETTINGS;
export type Settings = Record<SettingKey, string>;

export const isSettingKey = (k: string): k is SettingKey => Object.prototype.hasOwnProperty.call(SETTINGS, k);

/** Validate and normalise one value. Throws RangeError with a readable message. */
export function validateSetting(key: string, raw: unknown): string {
  if (!isSettingKey(key)) throw new RangeError(`Unknown setting "${key}"`);
  const def: SettingDef = SETTINGS[key];
  const v = raw == null ? '' : String(raw).trim();
  const k = def.kind;
  switch (k.type) {
    case 'text':
      if (k.max && v.length > k.max) throw new RangeError(`${key} must be at most ${k.max} characters`);
      return v;
    case 'enum':
      if (!k.values.includes(v)) throw new RangeError(`${key} must be one of ${k.values.join(', ')}`);
      return v;
    case 'bool':
      if (!['true', 'false'].includes(v)) throw new RangeError(`${key} must be true or false`);
      return v;
    case 'state':
      if (v && !STATES[v]) throw new RangeError(`${key}: unknown GST state code "${v}"`);
      return v;
    case 'gstin': {
      const g = v.toUpperCase();
      if (g && !stateFromGstin(g)) throw new RangeError('GSTIN must be 15 characters, starting with the 2-digit state code');
      return g;
    }
    case 'lang':
      if (!(SUPPORTED_LANGS as readonly string[]).includes(v)) throw new RangeError(`${key} must be one of ${SUPPORTED_LANGS.join(', ')}`);
      return v;
    case 'langs': {
      const list = v.split(',').map((s) => s.trim()).filter(Boolean);
      if (!list.length) throw new RangeError(`${key} needs at least one language`);
      for (const l of list) if (!(SUPPORTED_LANGS as readonly string[]).includes(l)) throw new RangeError(`${key}: unsupported language "${l}"`);
      return [...new Set(list)].join(',');
    }
    case 'docPrefix':
      if (!/^[A-Za-z0-9-]{0,6}$/.test(v)) throw new RangeError(`${key} must be up to 6 letters, digits or -`);
      return v.toUpperCase();
    case 'docFormat':
      validateDocFormat(v);
      return v;
    case 'int': {
      if (!/^\d+$/.test(v)) throw new RangeError(`${key} must be a whole number`);
      const n = Number(v);
      if (n < k.min || n > k.max) throw new RangeError(`${key} must be between ${k.min} and ${k.max}`);
      return String(n);
    }
    case 'amount': {
      const p = parseScaled(v, 2, key);
      if (p < 0) throw new RangeError(`${key} cannot be negative`);
      return (p / 100).toFixed(2).replace(/\.00$/, '');
    }
    case 'percent': {
      const bp = parseScaled(v, 2, key);
      if (bp < 0 || bp > k.max * 100) throw new RangeError(`${key} must be between 0 and ${k.max}`);
      return (bp / 100).toString();
    }
  }
}

/** Merge stored values over defaults. */
export function withDefaults(stored: Record<string, string>): Settings {
  const out = {} as Settings;
  for (const key of Object.keys(SETTINGS) as SettingKey[]) out[key] = stored[key] ?? SETTINGS[key].default;
  return out;
}

/** Settings that must be filled before billing, and are not. */
export function missingForBilling(s: Settings): SettingKey[] {
  const missing = (Object.keys(SETTINGS) as SettingKey[]).filter((k) => (SETTINGS[k] as SettingDef).requiredForBilling && !s[k]);
  if (s['gst.scheme'] !== 'unregistered' && !s['gst.gstin']) missing.push('gst.gstin');
  return missing;
}

/** Cross-field rule: GSTIN state must match the business state. */
export function checkSettingsConsistency(s: Settings): string[] {
  const issues: string[] = [];
  const g = stateFromGstin(s['gst.gstin']);
  if (g && s['business.state_code'] && g !== s['business.state_code']) issues.push('GSTIN state code does not match the business state');
  const langs = s['app.languages'].split(',');
  if (!langs.includes(s['app.default_lang'])) issues.push('Default language must be one of the enabled languages');
  if (!langs.includes(s['invoice.default_lang'])) issues.push('Default invoice language must be one of the enabled languages');
  if (s['invoice.label_mode'] === 'bilingual' && langs.length < 2) issues.push('Bilingual bills need two enabled languages');
  if (s['invoice.number_format'].includes('{prefix}') && !s['invoice.prefix']) issues.push('The number format uses {prefix}, so the invoice prefix cannot be empty');
  try {
    // longest realistic number: phone series code + every digit used
    const sample = formatDocNo({ prefix: s['invoice.prefix'], fy: '26-27', seriesCode: 'M9', pad: Number(s['invoice.seq_digits']), format: s['invoice.number_format'] }, 10 ** Number(s['invoice.seq_digits']) - 1);
    if (sample.length > DOC_NO_MAX) issues.push(`Invoice numbers would exceed ${DOC_NO_MAX} characters`);
  } catch (e) {
    issues.push((e as Error).message);
  }
  return issues;
}
