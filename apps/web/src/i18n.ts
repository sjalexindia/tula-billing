import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
/**
 * Translations live in locales/<lang>/<feature>.json. Every file in a language folder is merged,
 * so each feature owns its own file (top-level key = feature namespace, e.g. { "receipts": { … } }).
 * To add a language: add locales/<code>/ with the same files, and add the code to SUPPORTED_LANGS
 * (packages/core/src/settings.ts) and LANGS below. Which languages a business uses is a setting (app.languages).
 */
type Tree = { [k: string]: string | Tree };
const files = import.meta.glob<{ default: Tree }>('./locales/*/*.json', { eager: true });

function merge(into: Tree, from: Tree): Tree {
  for (const [k, v] of Object.entries(from)) {
    if (typeof v === 'object' && typeof into[k] === 'object') merge(into[k] as Tree, v);
    else into[k] = v;
  }
  return into;
}

const LANGS = ['en', 'ta'] as const;
export type Lang = (typeof LANGS)[number];
export const RESOURCES = Object.fromEntries(
  LANGS.map((l) => [l, {
    translation: Object.entries(files)
      .filter(([path]) => path.startsWith(`./locales/${l}/`))
      .sort(([a], [b]) => (a.endsWith('/core.json') ? -1 : b.endsWith('/core.json') ? 1 : a.localeCompare(b)))
      .reduce((acc, [, mod]) => merge(acc, mod.default), {} as Tree),
  }]),
) as Record<Lang, { translation: Tree }>;
export const isLang = (l: string | null | undefined): l is Lang => !!l && l in RESOURCES;

const saved = (() => {
  try {
    return localStorage.getItem('lang');
  } catch {
    return null;
  }
})();

void i18n.use(initReactI18next).init({
  resources: RESOURCES,
  lng: isLang(saved) ? saved : 'en',
  fallbackLng: 'en',
  interpolation: { escapeValue: false },
});

export function setLang(lang: Lang, remember = true) {
  void i18n.changeLanguage(lang);
  document.documentElement.lang = lang;
  if (!remember) return;
  try {
    localStorage.setItem('lang', lang);
  } catch {
    /* storage unavailable: the language still switches for this session */
  }
}

export const hasSavedLang = () => isLang(saved);

/** Fixed-language translator for printed bills (independent of the UI language). */
export const tFor = (lang: string) => i18n.getFixedT(isLang(lang) ? lang : 'en');

/** Pick the localised name of a record (records carry name_en and optional name_<lang>). */
export const nameIn = (lang: string, en: string, ta?: string | null) => (lang === 'ta' && ta ? ta : en);

export default i18n;
