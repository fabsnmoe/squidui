import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';

/**
 * Theme system. The initial value is applied by an inline script in index.html
 * before first paint, so a dark-mode user never sees a white flash.
 */

export type Theme = 'light' | 'dark';

const STORAGE_KEY = 'scp.theme';

interface ThemeContextValue {
  theme: Theme;
  toggle: () => void;
  set: (theme: Theme) => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

function readInitialTheme(): Theme {
  const attribute = document.documentElement.dataset.theme;
  if (attribute === 'light' || attribute === 'dark') return attribute;
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

export function ThemeProvider({ children }: { children: ReactNode }): JSX.Element {
  const [theme, setTheme] = useState<Theme>(readInitialTheme);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try {
      localStorage.setItem(STORAGE_KEY, theme);
    } catch {
      // Private mode without storage: the theme still applies for this session.
    }
  }, [theme]);

  // Follow the system preference until the user makes an explicit choice.
  useEffect(() => {
    if (localStorage.getItem(STORAGE_KEY)) return undefined;
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = (event: MediaQueryListEvent): void => setTheme(event.matches ? 'dark' : 'light');
    media.addEventListener('change', onChange);
    return () => media.removeEventListener('change', onChange);
  }, []);

  const set = useCallback((next: Theme) => setTheme(next), []);
  const toggle = useCallback(() => setTheme((current) => (current === 'dark' ? 'light' : 'dark')), []);

  const value = useMemo(() => ({ theme, toggle, set }), [theme, toggle, set]);
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const context = useContext(ThemeContext);
  if (!context) throw new Error('useTheme must be used inside a ThemeProvider.');
  return context;
}
