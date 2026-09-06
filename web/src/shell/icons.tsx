/** 16px line icons for the rail. No emoji, one stroke weight. */

const S = {
  width: 16,
  height: 16,
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.9,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
  "aria-hidden": true,
};

export function OverviewIcon() {
  return (
    <svg {...S}>
      <rect x="3" y="3" width="8" height="8" rx="1" />
      <rect x="13" y="3" width="8" height="5" rx="1" />
      <rect x="13" y="10" width="8" height="11" rx="1" />
      <rect x="3" y="13" width="8" height="8" rx="1" />
    </svg>
  );
}

export function CashIcon() {
  return (
    <svg {...S}>
      <path d="M3 17l5-6 4 3 4-6 5 4" />
      <path d="M3 21h18" />
    </svg>
  );
}

export function CollectIcon() {
  return (
    <svg {...S}>
      <path d="M4 12v6a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-6" />
      <path d="M12 3v11" />
      <path d="m8 10 4 4 4-4" />
    </svg>
  );
}

export function SpendIcon() {
  return (
    <svg {...S}>
      <rect x="3" y="6" width="18" height="13" rx="2" />
      <path d="M3 10h18" />
      <path d="M7 15h4" />
    </svg>
  );
}

export function PolicyIcon() {
  return (
    <svg {...S}>
      <path d="M12 3l7 3v6c0 4.4-3 7.7-7 9-4-1.3-7-4.6-7-9V6l7-3Z" />
      <path d="M9.5 12.5h5" />
      <path d="M12 10v5" />
    </svg>
  );
}

export function AuditIcon() {
  return (
    <svg {...S}>
      <path d="M6 3h9l4 4v14H6z" />
      <path d="M15 3v4h4" />
      <path d="M9 12h6M9 16h6" />
    </svg>
  );
}

export function InsightsIcon() {
  return (
    <svg {...S}>
      <path d="M4 20V10M10 20V4M16 20v-8M22 20H2" />
    </svg>
  );
}

export function AgentIcon() {
  return (
    <svg {...S}>
      <circle cx="12" cy="12" r="3" />
      <path d="M12 3v3M12 18v3M3 12h3M18 12h3" />
      <path d="M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M5.6 18.4l2.1-2.1M16.3 7.7l2.1-2.1" />
    </svg>
  );
}

export function DemoIcon() {
  return (
    <svg {...S}>
      <path d="m6 4 13 8-13 8V4Z" />
    </svg>
  );
}

export function ChevronLeft() {
  return (
    <svg {...S} width={13} height={13}>
      <path d="m15 5-7 7 7 7" />
    </svg>
  );
}

export function ChevronRight() {
  return (
    <svg {...S} width={13} height={13}>
      <path d="m9 5 7 7-7 7" />
    </svg>
  );
}
