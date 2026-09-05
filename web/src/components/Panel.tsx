import type { ReactNode } from "react";

interface Props {
  title: string;
  /** Contextual count / badge / legend, right-aligned in the header. */
  right?: ReactNode;
  className?: string;
  /** `panel-body-flush` for lists that draw their own row hairlines. */
  bodyClassName?: string;
  children: ReactNode;
}

/**
 * The one panel chrome every tile on the board uses: uppercase tracked title
 * left, contextual badge right, hairline beneath, body that scrolls inside a
 * fixed-height cell rather than growing the page.
 */
export function Panel({ title, right, className, bodyClassName, children }: Props) {
  return (
    <section className={className ? `panel ${className}` : "panel"}>
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
