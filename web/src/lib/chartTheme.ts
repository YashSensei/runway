/**
 * Chart colours, expressed as CSS custom-property references.
 *
 * SVG presentation attributes (`stroke`, `fill`, `stop-color`) accept
 * `var(--x)` in every evergreen browser and recharts passes them straight
 * through, so the chart reads from the same tokens as the rest of the
 * stylesheet. No hex lives here; change `:root` and the chart follows.
 */
export const CHART = {
  ok: "var(--ok)",
  danger: "var(--danger)",
  ghost: "var(--text-3)",
  hyp: "var(--accent)",
  axis: "var(--text-3)",
  grid: "var(--border)",
  surface: "var(--surface)",
  cursor: "var(--border)",
  zero: "var(--text-3)",
} as const;
