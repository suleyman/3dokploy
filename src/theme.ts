import type { DeployTrigger, ServiceKind, ServiceStatus } from './data/types';

/** Scene palette (dark sci-fi). The HUD mirrors these as CSS variables in styles.css. */
export const ACCENT = '#7c6cff';
export const NEON = '#2de2ff';
export const BG = '#03060c';

/** Cabinet lids, tank bands and HUD kind badges. */
export const KIND_COLOR: Record<ServiceKind, string> = {
  app: '#7c6cff',
  compose: '#19c6e6',
  postgres: '#4f8bff',
  redis: '#ff5a4f',
  mongo: '#2bd98a',
  mysql: '#ffb547',
  mariadb: '#d9895a',
  libsql: '#4ff8d2',
};

export const KIND_LABEL: Record<ServiceKind, string> = {
  app: 'App',
  compose: 'Compose',
  postgres: 'Postgres',
  redis: 'Redis',
  mongo: 'MongoDB',
  mysql: 'MySQL',
  mariadb: 'MariaDB',
  libsql: 'libSQL',
};

export const STATUS_LABEL: Record<ServiceStatus, string> = {
  running: 'Running',
  deploying: 'Deploying',
  error: 'Error',
  idle: 'Idle',
};

export const TRIGGER_LABEL: Record<DeployTrigger, string> = {
  push: 'git push',
  manual: 'manual',
};

/** Building colour presets (the same tones the projects get automatically, by name). */
export const PRESETS = [
  { key: 'violet', label: 'Violet', hex: '#7c6cff' },
  { key: 'cyan', label: 'Cyan', hex: '#2de2ff' },
  { key: 'green', label: 'Green', hex: '#2bd98a' },
  { key: 'amber', label: 'Amber', hex: '#ffb547' },
  { key: 'pink', label: 'Pink', hex: '#ff5fa2' },
  { key: 'blue', label: 'Blue', hex: '#4f8bff' },
  { key: 'purple', label: 'Purple', hex: '#c86bff' },
  { key: 'orange', label: 'Orange', hex: '#ff7a45' },
  { key: 'teal', label: 'Teal', hex: '#1fd1c1' },
  { key: 'lime', label: 'Lime', hex: '#d4f54a' },
  { key: 'sky', label: 'Sky', hex: '#8fd3ff' },
] as const;
export const presetHex = (key?: string) => PRESETS.find((p) => p.key === key)?.hex;
