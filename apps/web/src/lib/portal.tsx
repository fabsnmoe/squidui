import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { api, sessionExpired, setToken } from './api.js';

/**
 * Self-service portal session.
 *
 * A proxy identity, not a control plane account: it holds no permissions and
 * its token is rejected by every control plane endpoint. Kept in a separate
 * context so no component can accidentally treat one as the other.
 */

export interface PortalUser {
  username: string;
  providerKey: string;
  providerName: string | null;
  groups: string[];
  canChangePassword: boolean;
}

interface PortalContextValue {
  user: PortalUser | null;
  loading: boolean;
  login: (username: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
}

const PortalContext = createContext<PortalContextValue | null>(null);

const KIND_KEY = 'scp.session-kind';

/** Which login the stored token belongs to, so a reload restores the right shell. */
export function storedSessionKind(): 'control-plane' | 'portal' | null {
  const value = sessionStorage.getItem(KIND_KEY);
  return value === 'control-plane' || value === 'portal' ? value : null;
}

export function setStoredSessionKind(kind: 'control-plane' | 'portal' | null): void {
  if (kind) sessionStorage.setItem(KIND_KEY, kind);
  else sessionStorage.removeItem(KIND_KEY);
}

export function PortalProvider({ children }: { children: ReactNode }): JSX.Element {
  const [user, setUser] = useState<PortalUser | null>(null);
  const [loading, setLoading] = useState(storedSessionKind() === 'portal');

  useEffect(() => {
    if (storedSessionKind() !== 'portal') {
      setLoading(false);
      return undefined;
    }
    api<{ username: string; provider: { key: string; name: string }; groups: string[]; canChangePassword: boolean }>(
      '/portal/me',
    )
      .then((me) =>
        setUser({
          username: me.username,
          providerKey: me.provider.key,
          providerName: me.provider.name,
          groups: me.groups,
          canChangePassword: me.canChangePassword,
        }),
      )
      .catch(() => {
        setUser(null);
        setStoredSessionKind(null);
      })
      .finally(() => setLoading(false));

    const onExpired = (): void => {
      setUser(null);
      setStoredSessionKind(null);
    };
    sessionExpired.addEventListener('expired', onExpired);
    return () => sessionExpired.removeEventListener('expired', onExpired);
  }, []);

  const login = useCallback(async (username: string, password: string) => {
    const result = await api<{ token: string; user: PortalUser }>('/portal/session', {
      method: 'POST',
      body: { username, password },
    });
    setToken(result.token);
    setStoredSessionKind('portal');
    setUser(result.user);
  }, []);

  const logout = useCallback(async () => {
    try {
      await api('/portal/session', { method: 'DELETE' });
    } finally {
      setToken(null);
      setStoredSessionKind(null);
      setUser(null);
    }
  }, []);

  const value = useMemo(() => ({ user, loading, login, logout }), [user, loading, login, logout]);
  return <PortalContext.Provider value={value}>{children}</PortalContext.Provider>;
}

export function usePortal(): PortalContextValue {
  const context = useContext(PortalContext);
  if (!context) throw new Error('usePortal must be used inside a PortalProvider.');
  return context;
}
