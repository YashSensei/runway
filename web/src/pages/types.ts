/**
 * The contract every page implements.
 *
 * Pages are pure views over one `DashboardState`, polled once for the whole
 * app, so switching pages costs nothing and can never desync. Anything that
 * mutates goes through the helpers in `../api.ts` and shows up on the next
 * poll — pages never hold authoritative state of their own.
 */

import type { DashboardState } from "@shared/types";

export type PageId =
  | "overview"
  | "cash"
  | "collect"
  | "spend"
  | "policy"
  | "audit"
  | "insights"
  | "agent";

export interface PageProps {
  state: DashboardState;
  /** Navigate, e.g. to `#/audit/<decisionId>`. */
  navigate: (hash: string) => void;
  /** Sub-path after the page id, e.g. the decision id on `#/audit/<id>`. */
  param: string | null;
  /** Open the shared DecisionDetail modal from any page. */
  openDecision: (decisionId: string) => void;
  /** Open the shared EmailPreview modal from any page. */
  openEmail: (emailId: string) => void;
}

export interface RailEntry {
  id: PageId;
  label: string;
  /** Attention count shown as a badge; 0 hides it. */
  badge?: number;
  /** Danger badge (breach) rather than neutral count. */
  danger?: boolean;
}
