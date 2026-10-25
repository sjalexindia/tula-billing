import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import en from './locales/en.json';
import ta from './locales/ta.json';

/**
 * Translations shipped with the app. To add a language: add locales/<code>.json,
 * register it here and in SUPPORTED_LANGS (packages/core/src/settings.ts).
 * Which languages a business uses is a setting (app.languages).
 */
export const RESOURCES = { en: { translation: en }, ta: { translation: ta } } as const;
export type Lang = keyof typeof RESOURCES;
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
