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
