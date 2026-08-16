import { useEffect, useRef, useState } from 'react';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { Icon, IconButton, StatusBadge } from '@scp/ui';
import { useSession } from '../lib/session.js';
import { useTheme } from '../lib/theme.js';
import { CommandPalette } from './CommandPalette.js';
import { visibleNavigation } from './navigation.js';

export function AppShell(): JSX.Element {
  const { user, logout, can, build } = useSession();
  const { theme, toggle } = useTheme();
  const navigate = useNavigate();
  const location = useLocation();
  const [commandOpen, setCommandOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const mainRef = useRef<HTMLElement>(null);

  const groups = visibleNavigation(can);

  // Global shortcuts. `g` chords are documented in the command palette.
  useEffect(() => {
    let pendingGo = false;
    const onKeyDown = (event: KeyboardEvent): void => {
      const target = event.target as HTMLElement | null;
      const typing =
        target?.tagName === 'INPUT' || target?.tagName === 'TEXTAREA' || target?.isContentEditable === true;

      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setCommandOpen(true);
        return;
      }
      if (typing) return;

      if (event.key === '/') {
        const search = document.querySelector<HTMLInputElement>('input[type="search"]');
        if (search) {
          event.preventDefault();
          search.focus();
        }
        return;
      }
      if (pendingGo) {
        pendingGo = false;
        if (event.key === 'd') navigate('/');
        if (event.key === 'a') navigate('/authentication');
        return;
      }
      if (event.key === 'g') pendingGo = true;
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [navigate]);

  // Route changes move focus to the page heading (WCAG 2.4.3).
  useEffect(() => {
    const heading = mainRef.current?.querySelector<HTMLElement>('h1');
    heading?.focus();
  }, [location.pathname]);

  return (
    <div className="scp-shell" data-collapsed={collapsed}>
      <a className="scp-skip-link" href="#main-content">
        Skip to content
      </a>

      <aside className="scp-sidebar">
        <div className="scp-sidebar-brand">
          <span className="scp-sidebar-brand-mark" aria-hidden="true">
            <Icon name="shield" size={16} />
          </span>
          <span className="scp-sidebar-brand-text">
            <span className="scp-sidebar-brand-title">Squid Control Plane</span>
            <span className="scp-sidebar-brand-subtitle">{build?.appVersion ?? ''}</span>
          </span>
        </div>

        <nav className="scp-sidebar-nav" aria-label="Main">
          {groups.map((group) => (
            <div key={group.label}>
              <div className="scp-nav-group-label">{group.label}</div>
              <ul>
                {group.items.map((item) => (
                  <li key={item.to}>
                    <NavLink to={item.to} end={item.end} className="scp-nav-item" title={item.label}>
                      <span className="scp-nav-item-icon">
                        <Icon name={item.icon} />
                      </span>
                      <span className="scp-nav-item-label">{item.label}</span>
                    </NavLink>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </nav>
      </aside>

      <header className="scp-topbar">
        <IconButton
          label={collapsed ? 'Expand navigation' : 'Collapse navigation'}
          icon="drag"
          onClick={() => setCollapsed((value) => !value)}
        />
        <button
          type="button"
          className="scp-button"
          data-variant="secondary"
          data-size="sm"
          onClick={() => setCommandOpen(true)}
          style={{ minWidth: 220, justifyContent: 'flex-start', gap: 'var(--space-2)' }}
        >
          <Icon name="search" size={16} />
          <span className="scp-muted">Search or jump to…</span>
          <span className="scp-spacer" />
          <span className="scp-kbd">Ctrl K</span>
        </button>

        <span className="scp-spacer" />

        <IconButton
          label={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
          icon={theme === 'dark' ? 'sun' : 'moon'}
          onClick={toggle}
        />
        <StatusBadge tone="neutral">{user?.username ?? ''}</StatusBadge>
        <IconButton label="Sign out" icon="logout" onClick={() => void logout()} />
      </header>

      <main className="scp-main" id="main-content" ref={mainRef}>
        <Outlet />
      </main>

      <CommandPalette open={commandOpen} onClose={() => setCommandOpen(false)} />
    </div>
  );
}
