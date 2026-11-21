"use client";

import { useEffect, useState, useSyncExternalStore, type ReactNode } from "react";
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

    const delayMs = typedCount === 0 ? 260 : 42;
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
