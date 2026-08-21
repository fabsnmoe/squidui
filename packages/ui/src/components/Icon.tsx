import type { SVGProps } from 'react';

/**
 * Inline icon set.
 *
 * The UI ships no icon dependency and no webfont: every glyph is a stroked
 * 24x24 path, so an air-gapped deployment renders identically and the CSP can
 * stay strict.
 */

export const ICON_PATHS = {
  dashboard: 'M4 13h6V4H4v9Zm0 7h6v-5H4v5Zm10 0h6v-9h-6v9Zm0-16v5h6V4h-6Z',
  server: 'M4 5h16v5H4zM4 14h16v5H4zM8 7.5h.01M8 16.5h.01',
  network: 'M12 3v6m0 6v6M5 12h14M6 6l3 3m9-3-3 3M6 18l3-3m9 3-3-3',
  shield: 'M12 3l8 3v6c0 4.5-3.2 7.9-8 9-4.8-1.1-8-4.5-8-9V6l8-3Z',
  key: 'M15 7a4 4 0 1 1-3.9 5H9v2H7v2H4v-3l7.1-7.1A4 4 0 0 1 15 7Zm1.5 2.5h.01',
  users: 'M16 19v-1.5A3.5 3.5 0 0 0 12.5 14h-5A3.5 3.5 0 0 0 4 17.5V19M10 11a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Zm10 8v-1.5a3.5 3.5 0 0 0-2.6-3.4M15.5 4.2a3.5 3.5 0 0 1 0 6.6',
  group: 'M8 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6Zm8 0a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM2 19v-1a4 4 0 0 1 4-4h4a4 4 0 0 1 4 4v1m2-5h2a4 4 0 0 1 4 4v1',
  rules: 'M4 6h16M4 12h16M4 18h10M18 16l2 2 3-3',
  listener: 'M12 20v-6m0 0a4 4 0 1 0 0-8 4 4 0 0 0 0 8Zm-7-4a7 7 0 0 1 14 0',
  file: 'M14 3v5h5M14 3H6v18h12V8l-4-5ZM9 13h6M9 17h6',
  clock: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Zm0-14v5l3 2',
  settings:
    'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Zm8-3a8 8 0 0 0-.2-1.7l2-1.5-2-3.4-2.3 1a8 8 0 0 0-3-1.7L14 2h-4l-.5 2.7a8 8 0 0 0-3 1.7l-2.3-1-2 3.4 2 1.5a8 8 0 0 0 0 3.4l-2 1.5 2 3.4 2.3-1a8 8 0 0 0 3 1.7L10 22h4l.5-2.7a8 8 0 0 0 3-1.7l2.3 1 2-3.4-2-1.5c.1-.6.2-1.1.2-1.7Z',
  search: 'M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14Zm5.5-1.5L21 21',
  chevronDown: 'm6 9 6 6 6-6',
  chevronRight: 'm9 6 6 6-6 6',
  check: 'm5 13 4 4 10-10',
  close: 'M6 6l12 12M18 6 6 18',
  alert: 'M12 9v5m0 3h.01M10.3 4l-8 13.5A2 2 0 0 0 4 21h16a2 2 0 0 0 1.7-3.5L13.7 4a2 2 0 0 0-3.4 0Z',
  info: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Zm0-9v5m0-9h.01',
  help: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Zm-2-11a2 2 0 1 1 2.7 1.9c-.5.2-.7.6-.7 1.1v.5m0 3h.01',
  plus: 'M12 5v14M5 12h14',
  trash: 'M4 7h16M9 7V5h6v2m-8 0 1 13h8l1-13',
  edit: 'M4 20h4L20 8l-4-4L4 16v4Zm11-13 4 4',
  eye: 'M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6-10-6-10-6Zm10 2.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5Z',
  eyeOff: 'M4 4l16 16M10 5.2A9.6 9.6 0 0 1 12 5c6.5 0 10 6 10 6a17 17 0 0 1-3.3 3.9M6.3 7.4A17 17 0 0 0 2 11s3.5 6 10 6a9.9 9.9 0 0 0 3.5-.6',
  sun: 'M12 17a5 5 0 1 0 0-10 5 5 0 0 0 0 10Zm0-14v2m0 14v2M3 12h2m14 0h2M5.6 5.6 7 7m10 10 1.4 1.4M18.4 5.6 17 7M7 17l-1.4 1.4',
  moon: 'M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5Z',
  refresh: 'M20 11a8 8 0 1 0-.6 4M20 5v6h-6',
  copy: 'M9 9h10v10H9zM5 15V5h10',
  logout: 'M15 17l5-5-5-5M20 12H9M12 4H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h6',
  command: 'M6 3a3 3 0 1 1-3 3h12a3 3 0 1 1 3-3v12a3 3 0 1 1 3 3H9a3 3 0 1 1-3 3V3Z',
  audit: 'M9 5H7a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-2M9 5V3h6v2M9 5h6M9 12h6M9 16h4',
  test: 'M9 3h6M10 3v6l-5.6 9.7A2 2 0 0 0 6.1 22h11.8a2 2 0 0 0 1.7-3.3L14 9V3',
  drag: 'M9 6h.01M9 12h.01M9 18h.01M15 6h.01M15 12h.01M15 18h.01',
} as const;

export type IconName = keyof typeof ICON_PATHS;

export interface IconProps extends Omit<SVGProps<SVGSVGElement>, 'name'> {
  name: IconName;
  size?: number;
}

export function Icon({ name, size = 18, ...rest }: IconProps): JSX.Element {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      {...rest}
    >
      <path d={ICON_PATHS[name]} />
    </svg>
  );
}
