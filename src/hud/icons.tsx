import type { SVGProps } from 'react';

type P = SVGProps<SVGSVGElement>;

const base = (p: P) => ({
  width: 16,
  height: 16,
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 2,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
  'aria-hidden': true,
  ...p,
});

export const Logo = (p: P) => (
  <svg {...base({ width: 22, height: 22, ...p })} viewBox="0 0 32 32" stroke="none">
    <rect width="32" height="32" rx="8" fill="var(--accent)" />
    <path d="M16 6 26 11.5v9L16 26 6 20.5v-9z" fill="none" stroke="#fff" strokeWidth="2" strokeLinejoin="round" />
    <path d="M6 11.5 16 17l10-5.5M16 17v9" fill="none" stroke="#fff" strokeWidth="2" strokeLinejoin="round" />
  </svg>
);

export const SearchIcon = (p: P) => (
  <svg {...base(p)}>
    <circle cx="11" cy="11" r="7" />
    <path d="m20 20-3.5-3.5" />
  </svg>
);

export const BellIcon = (p: P) => (
  <svg {...base(p)}>
    <path d="M6 8a6 6 0 1 1 12 0c0 7 3 9 3 9H3s3-2 3-9" />
    <path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" />
  </svg>
);

export const PlusIcon = (p: P) => (
  <svg {...base(p)}>
    <path d="M12 5v14M5 12h14" />
  </svg>
);

export const MinusIcon = (p: P) => (
  <svg {...base(p)}>
    <path d="M5 12h14" />
  </svg>
);

export const ResetIcon = (p: P) => (
  <svg {...base(p)}>
    <path d="M3 12a9 9 0 1 0 3-6.7L3 8" />
    <path d="M3 3v5h5" />
  </svg>
);

export const FlameIcon = (p: P) => (
  <svg {...base(p)}>
    <path d="M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.38-.5-2-1-3-1.07-2.14-.22-4.05 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.15.43-2.29 1-3a2.5 2.5 0 0 0 2.5 2.5z" />
  </svg>
);

export const CloseIcon = (p: P) => (
  <svg {...base(p)}>
    <path d="M18 6 6 18M6 6l12 12" />
  </svg>
);

export const ExternalIcon = (p: P) => (
  <svg {...base({ width: 13, height: 13, ...p })}>
    <path d="M15 3h6v6M10 14 21 3M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
  </svg>
);

export const ExpandIcon = (p: P) => (
  <svg {...base(p)}>
    <path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7" />
  </svg>
);

export const ShrinkIcon = (p: P) => (
  <svg {...base(p)}>
    <path d="M4 14h6v6M20 10h-6V4M14 10l7-7M3 21l7-7" />
  </svg>
);

export const SoundIcon = (p: P) => (
  <svg {...base(p)}>
    <path d="M11 5 6 9H2v6h4l5 4V5z" />
    <path d="M15.5 8.5a5 5 0 0 1 0 7M19 5a10 10 0 0 1 0 14" />
  </svg>
);

export const MuteIcon = (p: P) => (
  <svg {...base(p)}>
    <path d="M11 5 6 9H2v6h4l5 4V5z" />
    <path d="m22 9-6 6M16 9l6 6" />
  </svg>
);

export const CheckIcon = (p: P) => (
  <svg {...base({ strokeWidth: 3, ...p })}>
    <path d="M20 6 9 17l-5-5" />
  </svg>
);

export const XIcon = (p: P) => (
  <svg {...base({ strokeWidth: 3, ...p })}>
    <path d="M18 6 6 18M6 6l12 12" />
  </svg>
);

export const GitIcon = (p: P) => (
  <svg {...base({ width: 13, height: 13, ...p })}>
    <circle cx="12" cy="12" r="3" />
    <path d="M3 12h6M15 12h6" />
  </svg>
);
