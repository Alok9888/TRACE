"use client";

import {
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import { cn } from "@/lib/utils";

function subscribeReducedMotion(callback: () => void) {
  const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
  mq.addEventListener("change", callback);
  return () => mq.removeEventListener("change", callback);
}

function getReducedMotionSnapshot() {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

export function usePrefersReducedMotion(): boolean {
  return useSyncExternalStore(
    subscribeReducedMotion,
    getReducedMotionSnapshot,
    () => false
  );
}

export function Reveal({
  visible,
  delay = 0,
  className,
  children,
}: {
  visible: boolean;
  delay?: number;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div
      data-visible={visible ? "true" : "false"}
      style={delay > 0 ? { transitionDelay: `${delay}ms` } : undefined}
      className={cn("reveal-item", className)}
    >
      {children}
    </div>
  );
}

/**
 * Tactile monochrome card with zero-rerender pointer-tracked specular highlight
 * and an expanding top hairline beam on hover.
 */
export function SpotlightCard({
  className,
  children,
}: {
  className?: string;
  children: ReactNode;
}) {
  function handlePointerMove(e: ReactPointerEvent<HTMLDivElement>) {
    const rect = e.currentTarget.getBoundingClientRect();
    e.currentTarget.style.setProperty("--mx", `${e.clientX - rect.left}px`);
    e.currentTarget.style.setProperty("--my", `${e.clientY - rect.top}px`);
  }

  return (
    <div
      onPointerMove={handlePointerMove}
      className={cn("spotlight-card", className)}
    >
      {children}
    </div>
  );
}

/**
 * Smooth cubic-out numeric telemetry counter triggered on section entry.
 */
export function AnimatedNumber({
  from = 0,
  to,
  active,
  reducedMotion,
  durationMs = 760,
  prefix = "",
  suffix = "",
}: {
  from?: number;
  to: number;
  active: boolean;
  reducedMotion: boolean;
  durationMs?: number;
  prefix?: string;
  suffix?: string;
}) {
  const [value, setValue] = useState(from);
  const startedRef = useRef(false);

  useEffect(() => {
    if (!active || reducedMotion || startedRef.current) return;
    startedRef.current = true;

    let rafId = 0;
    const start = performance.now();

    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / durationMs);
      const eased = 1 - Math.pow(1 - t, 3);
      setValue(Math.round(from + (to - from) * eased));
      if (t < 1) {
        rafId = requestAnimationFrame(tick);
      }
    };

    rafId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafId);
  }, [active, reducedMotion, from, to, durationMs]);

  const shown = reducedMotion ? to : active ? value : from;
  return (
    <span className="tabular-telemetry">
      {prefix}
      {shown}
      {suffix}
    </span>
  );
}

export function SignatureTypewriter({
  text,
  active,
  reducedMotion,
  className,
}: {
  text: string;
  active: boolean;
  reducedMotion: boolean;
  className?: string;
}) {
  const [typedCount, setTypedCount] = useState(0);

  useEffect(() => {
    if (!active || reducedMotion) return;
    if (typedCount >= text.length) return;

    const delayMs = typedCount === 0 ? 240 : 40;
    const timer = window.setTimeout(() => {
      setTypedCount((prev) => Math.min(text.length, prev + 1));
    }, delayMs);

    return () => window.clearTimeout(timer);
  }, [active, reducedMotion, typedCount, text.length]);

  const displayedCount = reducedMotion ? text.length : active ? typedCount : 0;
  const displayed = text.slice(0, displayedCount);
  const showCursor = active || reducedMotion;

  return (
    <span className={cn("inline-grid items-baseline", className)} aria-label={text}>
      {/* Full-string invisible reservation prevents any horizontal/vertical layout shift while typing */}
      <span
        aria-hidden="true"
        className="invisible col-start-1 row-start-1 inline-flex items-baseline whitespace-pre select-none"
      >
        <span>{text}</span>
        <span className="ml-1 inline-block h-[0.95em] w-[2px]" />
      </span>
      <span
        aria-hidden="true"
        className="col-start-1 row-start-1 inline-flex items-baseline whitespace-pre"
      >
        <span>{displayed}</span>
        {showCursor && (
          <span className="trace-caret ml-1 inline-block h-[0.95em] w-[2px] translate-y-[0.08em] bg-foreground/85" />
        )}
      </span>
    </span>
  );
}

/**
 * Smooth character-by-character backspace + retype transition strictly on a target noun.
 * Reserves the widest candidate width via an invisible grid layer to prevent layout shift,
 * handles rapid toggling safely via effect timer cleanup, and swaps immediately under reduced motion.
 */
export function DynamicNounTypewriter({
  target,
  candidates,
  reducedMotion,
  trailingPunctuation = ".",
  className,
}: {
  target: string;
  candidates: readonly string[];
  reducedMotion: boolean;
  trailingPunctuation?: string;
  className?: string;
}) {
  const [displayed, setDisplayed] = useState(target);

  useEffect(() => {
    if (reducedMotion || displayed === target) return;

    const isPrefix = target.startsWith(displayed);
    const delayMs = isPrefix
      ? displayed.length === 0
        ? 75
        : 44
      : 32;

    const timer = window.setTimeout(() => {
      setDisplayed((prev) => {
        if (target.startsWith(prev)) {
          return target.slice(0, prev.length + 1);
        }
        return prev.slice(0, Math.max(0, prev.length - 1));
      });
    }, delayMs);

    return () => window.clearTimeout(timer);
  }, [displayed, target, reducedMotion]);

  const activeText = reducedMotion ? target : displayed;
  const isAnimating = !reducedMotion && activeText !== target;
  const widestCandidate = candidates.reduce(
    (longest, item) => (item.length > longest.length ? item : longest),
    target
  );

  return (
    <span
      className={cn("inline-grid items-baseline align-baseline", className)}
      aria-live="polite"
      aria-label={`${target}${trailingPunctuation}`}
    >
      {/* Reserve width of the widest candidate so headline lines never jump or reflow */}
      <span
        aria-hidden="true"
        className="invisible col-start-1 row-start-1 inline-flex items-baseline whitespace-pre select-none"
      >
        <span>
          {widestCandidate}
          {trailingPunctuation}
        </span>
        <span className="ml-0.5 inline-block h-[0.82em] w-[2px]" />
      </span>

      <span
        aria-hidden="true"
        className="col-start-1 row-start-1 inline-flex items-baseline whitespace-pre"
      >
        <span>
          {activeText}
          {!isAnimating ? trailingPunctuation : ""}
        </span>
        {isAnimating && (
          <span className="trace-caret ml-0.5 inline-block h-[0.82em] w-[2px] translate-y-[0.04em] bg-foreground" />
        )}
      </span>
    </span>
  );
}
