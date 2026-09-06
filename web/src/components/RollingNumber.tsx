import { useEffect, useRef, useState } from "react";

interface Props {
  /** Integer rupees. */
  value: number;
  /** Formatter applied to the interpolated value on every frame. */
  format: (value: number) => string;
  /** Tween length. Short: motion here means "the agent changed a number". */
  durationMs?: number;
}

/**
 * Renders `format(value)` and, when `value` changes, rolls the displayed
 * figure from the previous value to the new one. The first render is
 * instantaneous so a page load never animates from zero.
 */
export function RollingNumber({ value, format, durationMs = 520 }: Props) {
  const [shown, setShown] = useState(value);
  const fromRef = useRef(value);
  const frame = useRef<number | null>(null);

  useEffect(() => {
    const from = fromRef.current;
    if (from === value || !Number.isFinite(from) || !Number.isFinite(value)) {
      fromRef.current = value;
      setShown(value);
      return;
    }
    const reduce =
      typeof window !== "undefined" &&
      window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;
    if (reduce) {
      fromRef.current = value;
      setShown(value);
      return;
    }

    const start = performance.now();
    const step = (t: number) => {
      const p = Math.min(1, (t - start) / durationMs);
      const eased = 1 - Math.pow(1 - p, 3);
      setShown(Math.round(from + (value - from) * eased));
      if (p < 1) {
        frame.current = requestAnimationFrame(step);
      } else {
        fromRef.current = value;
        frame.current = null;
      }
    };
    if (frame.current !== null) cancelAnimationFrame(frame.current);
    frame.current = requestAnimationFrame(step);
    return () => {
      if (frame.current !== null) cancelAnimationFrame(frame.current);
      frame.current = null;
      fromRef.current = value;
    };
  }, [value, durationMs]);

  return <>{format(shown)}</>;
}
