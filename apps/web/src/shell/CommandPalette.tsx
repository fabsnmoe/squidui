import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Icon } from '@scp/ui';
import { useSession } from '../lib/session.js';
import { useTheme } from '../lib/theme.js';
import { visibleNavigation } from './navigation.js';

interface Command {
  id: string;
  label: string;
  group: string;
  icon: Parameters<typeof Icon>[0]['name'];
  keywords: string[];
  run: () => void;
}

export interface CommandPaletteProps {
  open: boolean;
  onClose: () => void;
}

export function CommandPalette({ open, onClose }: CommandPaletteProps): JSX.Element | null {
  const navigate = useNavigate();
  const { can } = useSession();
  const { toggle, theme } = useTheme();
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const commands = useMemo<Command[]>(() => {
    const pages = visibleNavigation(can).flatMap((group) =>
      group.items.map((item) => ({
        id: `page:${item.to}`,
        label: item.label,
        group: group.label,
        icon: item.icon,
        keywords: item.keywords ?? [],
        run: () => navigate(item.to),
      })),
    );

    const actions: Command[] = [
      {
        id: 'action:theme',
        label: theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme',
        group: 'Actions',
        icon: theme === 'dark' ? 'sun' : 'moon',
        keywords: ['dark', 'light', 'appearance'],
        run: toggle,
      },
    ];

    return [...pages, ...actions];
  }, [can, navigate, theme, toggle]);

  const results = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (needle === '') return commands;
    return commands.filter((command) =>
      [command.label, command.group, ...command.keywords].some((value) => value.toLowerCase().includes(needle)),
    );
  }, [commands, query]);

  useEffect(() => {
    if (!open) return;
    setQuery('');
    setActiveIndex(0);
    window.setTimeout(() => inputRef.current?.focus(), 0);
  }, [open]);

  useEffect(() => setActiveIndex(0), [query]);

  if (!open) return null;

  const run = (command: Command | undefined): void => {
    if (!command) return;
    command.run();
    onClose();
  };

  const onKeyDown = (event: React.KeyboardEvent): void => {
    if (event.key === 'Escape') {
      event.preventDefault();
      onClose();
    } else if (event.key === 'ArrowDown') {
      event.preventDefault();
      setActiveIndex((index) => Math.min(index + 1, results.length - 1));
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActiveIndex((index) => Math.max(index - 1, 0));
    } else if (event.key === 'Enter') {
      event.preventDefault();
      run(results[activeIndex]);
    }
  };

  let lastGroup = '';

  return (
    <div
      className="scp-command-scrim"
      onMouseDown={(event) => event.target === event.currentTarget && onClose()}
    >
      <div className="scp-command" role="dialog" aria-modal="true" aria-label="Command palette">
        <input
          ref={inputRef}
          className="scp-command-input"
          type="text"
          value={query}
          placeholder="Search pages and actions…"
          aria-label="Search pages and actions"
          aria-controls="scp-command-results"
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={onKeyDown}
        />
        <div className="scp-command-list" id="scp-command-results" role="listbox">
          {results.length === 0 ? (
            <div className="scp-hint" style={{ padding: 'var(--space-4)' }}>
              Nothing matches “{query}”.
            </div>
          ) : (
            results.map((command, index) => {
              const showGroup = command.group !== lastGroup;
              lastGroup = command.group;
              return (
                <div key={command.id}>
                  {showGroup ? <div className="scp-nav-group-label">{command.group}</div> : null}
                  <button
                    type="button"
                    role="option"
                    aria-selected={index === activeIndex}
                    className="scp-command-item"
                    data-active={index === activeIndex}
                    onMouseEnter={() => setActiveIndex(index)}
                    onClick={() => run(command)}
                  >
                    <Icon name={command.icon} />
                    <span>{command.label}</span>
                  </button>
                </div>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}
