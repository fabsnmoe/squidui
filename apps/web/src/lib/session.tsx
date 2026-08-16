import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { Permission } from '@scp/shared';
import { api, sessionExpired, setToken } from './api.js';
import { setStoredSessionKind, storedSessionKind } from './portal.js';

/**
 * Control plane session state.
 *
 * Permissions come from the server on every session load; the UI uses them to
 * hide what the user cannot do. The API enforces them independently - the
 * client side check is convenience, never security.
 */

export interface SessionUser {
  id: string;
  username: string;
  displayName: string | null;
  permissions: string[];
  mustChangePassword: boolean;
}

interface SessionContextValue {
  user: SessionUser | null;
  loading: boolean;
  can: (permission: Permission) => boolean;
  login: (username: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  refresh: () => Promise<void>;
  build: { appVersion: string; gitSha: string; buildDate: string } | null;
}

const SessionContext = createContext<SessionContextValue | null>(null);

export function SessionProvider({ children }: { children: ReactNode }): JSX.Element {
  const [user, setUser] = useState<SessionUser | null>(null);
  const [build, setBuild] = useState<SessionContextValue['build']>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    // A stored portal token must not be probed against the control plane
    // endpoint: it would only produce a 401 and clear a perfectly good session.
    if (storedSessionKind() === 'portal') {
      setUser(null);
      setLoading(false);
      return;
    }
    try {
      const result = await api<{ user: SessionUser; build: NonNullable<SessionContextValue['build']> }>('/session');
      setUser(result.user);
      setBuild(result.build);
    } catch {
      setUser(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const onExpired = (): void => setUser(null);
    sessionExpired.addEventListener('expired', onExpired);
    return () => sessionExpired.removeEventListener('expired', onExpired);
  }, [refresh]);

  const login = useCallback(async (username: string, password: string) => {
    const result = await api<{ token: string; user: SessionUser }>('/session', {
      method: 'POST',
      body: { username, password },
    });
    setToken(result.token);
    setStoredSessionKind('control-plane');
    setUser(result.user);
  }, []);

  const logout = useCallback(async () => {
    try {
      await api('/session', { method: 'DELETE' });
    } finally {
      setToken(null);
      setStoredSessionKind(null);
      setUser(null);
    }
  }, []);

  const value = useMemo<SessionContextValue>(
    () => ({
      user,
      loading,
      build,
      login,
      logout,
      refresh,
      can: (permission) => Boolean(user?.permissions.includes(permission)),
    }),
    [user, loading, build, login, logout, refresh],
  );

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionContextValue {
  const context = useContext(SessionContext);
  if (!context) throw new Error('useSession must be used inside a SessionProvider.');
  return context;
}
