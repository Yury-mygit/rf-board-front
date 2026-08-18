// BRD-6: минимальный i18n runtime.
// Static JSON dicts (vite native transform). Browser lang detect → ru
// (fallback) / en. Все новые UI-строки идут через t(), миграция
// существующих hardcoded строк — отдельный refactor-task в бэклоге.

import ru from './i18n/ru.json';
import en from './i18n/en.json';

const DICTS = { ru, en };
const FALLBACK = 'ru';

function detectLang() {
  try {
    const raw = (navigator.language || '').slice(0, 2).toLowerCase();
    return DICTS[raw] ? raw : FALLBACK;
  } catch {
    return FALLBACK;
  }
}

let currentLang = detectLang();

function resolve(dict, key) {
  return key.split('.').reduce(
    (acc, part) => (acc && typeof acc === 'object' && part in acc ? acc[part] : null),
    dict,
  );
}

// t('zorder.front') → 'На передний план'
// t('zorder.error', { msg: 'foo' }) → 'Ошибка z-order: foo'
// Missing key → warn + return key itself (dev-friendly).
export function t(key, params) {
  let str = resolve(DICTS[currentLang], key);
  if (str == null && currentLang !== FALLBACK) str = resolve(DICTS[FALLBACK], key);
  if (str == null) {
    console.warn(`[i18n] missing key: ${key}`);
    return key;
  }
  if (params && typeof str === 'string') {
    str = str.replace(/\{(\w+)\}/g, (m, name) =>
      name in params ? String(params[name]) : m,
    );
  }
  return str;
}

export function getLang() {
  return currentLang;
}

export function setLang(lang) {
  if (DICTS[lang]) currentLang = lang;
}
