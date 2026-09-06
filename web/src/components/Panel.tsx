import type { ReactNode } from "react";

/**
 * Visual weight. `hero` is what the agent just did; `primary` is what the CFO
 * decides on; `reference` is everything one looks up. Reference panels take
 * muted headings and lose their header badges so the eye lands elsewhere.
 */
export type PanelTier = "hero" | "primary" | "reference";

interface Props {
  title: string;
  /** Contextual count / chip / legend, right-aligned in the header. */
  right?: ReactNode;
  className?: string;
  /** `panel-body-flush` for lists that draw their own row hairlines. */
  bodyClassName?: string;
  tier?: PanelTier;
  children: ReactNode;
}

/**
 * The one panel chrome every tile on the board uses: sentence-case title
 * left, contextual chip right, hairline beneath, body that scrolls inside a
 * fixed-height cell rather than growing the page.
 */
export function Panel({ title, right, className, bodyClassName, tier, children }: Props) {
  const classes = ["panel", tier ? `panel-${tier}` : "", className ?? ""]
    .filter(Boolean)
    .join(" ");
  return (
    <section className={classes}>
      <div className="panel-head">
        <span className="panel-title">{title}</span>
        {right !== undefined ? <span className="panel-right">{right}</span> : null}
      </div>
      <div className={bodyClassName ? `panel-body ${bodyClassName}` : "panel-body"}>
        {children}
      </div>
    </section>
  );
}

/** One-line, ~44px, never a void. */
export function Empty({ children }: { children: ReactNode }) {
  return <div className="empty">{children}</div>;
}
