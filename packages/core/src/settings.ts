/**
 * The settings registry: every business-specific value lives here as data,
 * never in code. Unknown keys are rejected; each key has a type and default.
 */
import { stateFromGstin } from './gst';
import { STATES } from './states';

type Kind =
  | { type: 'text'; max?: number }
  | { type: 'enum'; values: readonly string[] }
  | { type: 'bool' }
  | { type: 'state' }
  | { type: 'gstin' }
  | { type: 'langs' }
  | { type: 'lang' }
  | { type: 'docPrefix' };

export interface SettingDef {
  kind: Kind;
  default: string;
  /** must be filled before the first bill can be saved */
  requiredForBilling?: boolean;
  /** owner-only to change (all settings are owner-only in Release 1, kept for later roles) */
  group: 'business' | 'gst' | 'invoice' | 'billing' | 'app';
}

/** Languages the app ships translations for. Add a locale file and an entry here to add one. */
export const SUPPORTED_LANGS = ['en', 'ta'] as const;
export type LangCode = (typeof SUPPORTED_LANGS)[number];

export const SETTINGS = {
  // ---- Business identity (printed on every invoice)
  'business.name_en': { kind: { type: 'text', max: 80 }, default: '', requiredForBilling: true, group: 'business' },
  'business.name_ta': { kind: { type: 'text', max: 80 }, default: '', group: 'business' },
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
  'invoice.prefix': { kind: { type: 'docPrefix' }, default: 'INV', group: 'invoice' },

  // ---- Billing rules
  'billing.stock_check': { kind: { type: 'enum', values: ['warn', 'block', 'off'] }, default: 'warn', group: 'billing' },
  'billing.credit_check': { kind: { type: 'enum', values: ['warn', 'block', 'off'] }, default: 'warn', group: 'billing' },

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
      if (!/^[A-Za-z0-9-]{1,6}$/.test(v)) throw new RangeError(`${key} must be 1–6 letters, digits or -`);
      return v.toUpperCase();
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
  return issues;
}
