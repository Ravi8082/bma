import en from "./languages/en.json";
import hi from "./languages/hi.json";

const catalogs: Record<string, Record<string, string>> = {
  en: en as Record<string, string>,
  hi: hi as Record<string, string>,
  hinglish: en as Record<string, string>, // hinglish falls back to en strings with hi loan words later
};

export function t(lang: string, key: string, vars?: Record<string, string | number>): string {
  const catalog = catalogs[lang] ?? catalogs.hinglish ?? {};
  const fallback = catalogs.en ?? {};
  let str = catalog[key] ?? fallback[key] ?? key;
  if (vars) {
    for (const [k, v] of Object.entries(vars)) {
      str = str.replace(new RegExp(`\\{${k}\\}`, "g"), String(v));
    }
  }
  return str;
}

export function availableLanguages(): string[] {
  return Object.keys(catalogs);
}

export function hasKeyParity(): boolean {
  const enCatalog = catalogs.en ?? {};
  const keys = Object.keys(enCatalog);
  return Object.values(catalogs).every((c) => {
    const catalog = c ?? {};
    return keys.every((k) => Object.prototype.hasOwnProperty.call(catalog, k));
  });
}
