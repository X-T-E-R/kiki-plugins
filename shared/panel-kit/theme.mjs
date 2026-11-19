/**
 * Unified 4-way presentation and theme synchronization for Kiki plugin panels:
 * 1) URL ?theme=dark|light initial hydration
 * 2) Host theme / colorScheme switching (dark / light / auto)
 * 3) Host appearance skin CSS custom property injection (--color-*)
 * 4) Host locale propagation callback
 */

export function applyThemeName(theme, root) {
  const el = root || (typeof document !== 'undefined' ? document.documentElement : null);
  if (!el) return null;
  if (theme === 'dark' || theme === 'light') {
    if (typeof el.setAttribute === 'function') el.setAttribute('data-theme', theme);
    if (el.dataset) el.dataset.theme = theme;
    return theme;
  }
  if (theme === 'auto' || theme === 'system') {
    if (typeof el.removeAttribute === 'function') el.removeAttribute('data-theme');
    if (el.dataset) delete el.dataset.theme;
    return 'auto';
  }
  return null;
}

export function initThemeFromUrl(options = {}) {
  try {
    if (typeof URLSearchParams !== 'function') return null;
    let urlTheme = null;
    if (options.search !== undefined) {
      urlTheme = new URLSearchParams(options.search).get('theme');
    } else if (typeof window !== 'undefined' && window.location && typeof window.location.search === 'string') {
      urlTheme = new URLSearchParams(window.location.search).get('theme');
    } else if (typeof location !== 'undefined' && typeof location.search === 'string') {
      urlTheme = new URLSearchParams(location.search).get('theme');
    }
    if (urlTheme === 'dark' || urlTheme === 'light') {
      return applyThemeName(urlTheme, options.root);
    }
  } catch {}
  return null;
}

export function applyPresentation(presentation, options = {}) {
  const opts = typeof options === 'string' ? { fallbackTheme: options } : (options || {});
  const el = opts.root || (typeof document !== 'undefined' ? document.documentElement : null);
  const pres = presentation && typeof presentation === 'object' ? presentation : null;
  const theme = applyThemeName(
    (pres && (pres.theme || pres.colorScheme)) || opts.fallbackTheme,
    el,
  );

  const tokenPrefix = typeof opts.tokenPrefix === 'string' ? opts.tokenPrefix : '--color-';
  const appliedTokens = [];
  if (el && el.style && typeof el.style.setProperty === 'function' && pres && pres.tokens && typeof pres.tokens === 'object') {
    for (const [key, value] of Object.entries(pres.tokens)) {
      if (typeof key === 'string' && key.startsWith(tokenPrefix) && typeof value === 'string' && value.trim()) {
        el.style.setProperty(key, value.trim());
        appliedTokens.push(key);
      }
    }
  }

  let locale = null;
  if (pres && typeof pres.locale === 'string' && pres.locale.trim()) {
    locale = pres.locale.trim();
    if (typeof opts.onLocale === 'function') {
      opts.onLocale(locale);
    }
  }

  return { theme, locale, appliedTokens };
}
