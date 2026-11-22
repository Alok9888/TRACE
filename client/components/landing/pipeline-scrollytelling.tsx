"use client";

import type { RefObject } from "react";
import { ArrowDown } from "lucide-react";

import { SpotlightCard } from "@/components/landing/scroll-reveal";
import { cn } from "@/lib/utils";

export const PIPELINE_BEATS = [
  {
    step: "01",
    shortLabel: "INGEST",
    headline: "1-Pass Stream",
    tagline: "Single HTTP/2 zipball. Unchanged files skipped via SHA diff.",
  },
  {
    step: "02",
    shortLabel: "PACK 64×",
    headline: "108 → 31 Calls",
    tagline: "1,600-char line slices packed into full 64-chunk batches.",
  },
  {
    step: "03",
    shortLabel: "QUERY",
    headline: "Direct Vector SQL",
    tagline: "384-dim HNSW cosine search straight to file and line.",
  },
] as const;

const INGEST_FILES = [
  { path: "ChatStreamHandler.java", tag: "STREAM", dim: false },
  { path: "CodeContextRetriever.java", tag: "STREAM", dim: false },
  { path: "EmbeddingConfig.java", tag: "SHA SKIP", dim: true },
  { path: "package-lock.json", tag: "SKIP", dim: true },
] as const;

const VECTOR_MATCHES = [
  { file: "ChatStreamHandler.java:318", score: "0.92", width: "92%" },
  { file: "CodeContextRetriever.java:139", score: "0.87", width: "87%" },
  { file: "EmbeddingConfig.java:56", score: "0.81", width: "81%" },
] as const;

function PipelineTelemetryVisual({ activeBeat }: { activeBeat: number }) {
  return (
    <SpotlightCard className="flex h-full flex-col justify-between border border-border/80 bg-card/75 p-4 backdrop-blur-md sm:p-5">
      <div className="flex items-center justify-between border-b border-border/70 pb-2.5 font-mono text-[10px] tracking-[0.16em] text-muted-foreground uppercase">
        <div className="flex items-center gap-2">
          <span className="size-1.5 rounded-full bg-foreground" />
          <span>{`${PIPELINE_BEATS[activeBeat].step} // ${PIPELINE_BEATS[activeBeat].shortLabel}`}</span>
        </div>
        <span className="tabular-telemetry text-foreground/85">
          {`0${activeBeat + 1} / 0${PIPELINE_BEATS.length}`}
        </span>
      </div>

      {/* All 3 visuals share one grid cell for zero layout shift */}
      <div className="relative my-3 grid flex-1 items-center">
        {/* BEAT 0: 1-PASS INGEST */}
        <div
          aria-hidden={activeBeat !== 0}
          className={cn(
            "col-start-1 row-start-1 space-y-2 transition-all duration-500 ease-out",
            activeBeat === 0
              ? "translate-y-0 opacity-100"
              : "pointer-events-none translate-y-3 opacity-0"
          )}
        >
          <div className="flex items-center justify-between font-mono text-[10px] tracking-[0.12em] text-muted-foreground uppercase">
            <span>HTTP/2 ZIPBALL</span>
            <span className="tabular-telemetry text-foreground">0% RE-EMBEDS</span>
          </div>
          <div className="divide-y divide-border/50 border border-border/70 bg-background/60">
            {INGEST_FILES.map((file, idx) => (
              <div
                key={file.path}
                style={{ transitionDelay: activeBeat === 0 ? `${idx * 55}ms` : "0ms" }}
                className={cn(
                  "flex items-center justify-between gap-2 px-3 py-2 font-mono text-[11px] transition-all duration-500",
                  activeBeat === 0 ? "translate-x-0 opacity-100" : "-translate-x-2 opacity-0",
                  file.dim ? "text-muted-foreground/45" : "text-foreground"
                )}
              >
                <span className="truncate">{file.path}</span>
                <span
                  className={cn(
                    "shrink-0 border px-1.5 py-0.5 text-[9px] tracking-[0.1em] uppercase",
                    file.dim
                      ? "border-border/50 text-muted-foreground/45"
                      : "border-foreground/40 text-foreground"
                  )}
                >
                  {file.tag}
                </span>
              </div>
            ))}
          </div>
        </div>

        {/* BEAT 1: 64x CROSS-FILE BATCHING */}
        <div
          aria-hidden={activeBeat !== 1}
          className={cn(
            "col-start-1 row-start-1 space-y-3 transition-all duration-500 ease-out",
            activeBeat === 1
              ? "translate-y-0 opacity-100"
              : "pointer-events-none translate-y-3 opacity-0"
          )}
        >
          <div className="space-y-1.5">
            <div className="flex items-center justify-between font-mono text-[10px] tracking-[0.12em] text-muted-foreground uppercase">
              <span>BEFORE</span>
              <span className="tabular-telemetry line-through opacity-65">108 CALLS</span>
            </div>
            <div className="grid grid-cols-12 gap-1 opacity-40">
              {Array.from({ length: 12 }).map((_, i) => (
                <div key={i} className="h-2.5 border border-border bg-muted/40" />
              ))}
            </div>
          </div>

          <div className="space-y-1.5">
            <div className="flex items-center justify-between font-mono text-[10px] tracking-[0.12em] text-foreground uppercase">
              <span>64× CROSS-FILE BATCHES</span>
              <span className="tabular-telemetry font-semibold">31 CALLS · 3.5×</span>
            </div>
            <div className="grid grid-cols-4 gap-1.5">
              {[64, 64, 64, 64].map((size, idx) => (
                <div
                  key={idx}
                  style={{ transitionDelay: activeBeat === 1 ? `${idx * 70}ms` : "0ms" }}
                  className={cn(
                    "flex h-11 flex-col items-center justify-center border border-foreground/70 bg-foreground/[0.08] font-mono transition-all duration-500",
                    activeBeat === 1 ? "scale-100 opacity-100" : "scale-95 opacity-0"
                  )}
                >
                  <span className="tabular-telemetry text-xs font-semibold text-foreground">
                    {size}
                  </span>
                </div>
              ))}
            </div>
          </div>

          <div className="flex items-center justify-between border-t border-border/60 pt-2 font-mono text-[10px] text-muted-foreground">
            <span>bge-small-en-v1.5</span>
            <span className="tabular-telemetry text-foreground">384-DIM · 1,600 CHARS</span>
          </div>
        </div>

        {/* BEAT 2: DIRECT INDEXED SQL */}
        <div
          aria-hidden={activeBeat !== 2}
          className={cn(
            "col-start-1 row-start-1 space-y-3 transition-all duration-500 ease-out",
            activeBeat === 2
              ? "translate-y-0 opacity-100"
              : "pointer-events-none translate-y-3 opacity-0"
          )}
        >
          <div className="truncate border border-border/70 bg-background/70 px-3 py-2 font-mono text-[10px] text-muted-foreground">
            <span className="text-foreground">ORDER BY</span> embedding &lt;=&gt; $1{" "}
            <span className="text-foreground">LIMIT</span> 5
          </div>

          <div className="space-y-2.5">
            {VECTOR_MATCHES.map((m, idx) => (
              <div key={m.file} className="space-y-1">
                <div className="flex items-center justify-between font-mono text-[11px]">
                  <span className="truncate text-foreground/90">{m.file}</span>
                  <span className="tabular-telemetry text-foreground">{m.score}</span>
                </div>
                <div className="h-[2px] w-full bg-border/60">
                  <div
                    data-visible={activeBeat === 2 ? "true" : "false"}
                    style={{
                      width: m.width,
                      transitionDelay: activeBeat === 2 ? `${idx * 75}ms` : "0ms",
                    }}
                    className="metric-bar-fill h-full bg-foreground"
                  />
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className="flex items-center justify-between border-t border-border/70 pt-2.5 font-mono text-[10px] tracking-[0.14em] text-muted-foreground uppercase">
        <span>160 MB JVM HEAP</span>
        <div className="flex items-center gap-1.5">
          {PIPELINE_BEATS.map((b, i) => (
            <span
              key={b.step}
              className={cn(
                "block h-[2px] transition-all duration-300",
                i <= activeBeat ? "w-6 bg-foreground" : "w-3 bg-border"
              )}
            />
          ))}
        </div>
      </div>
    </SpotlightCard>
  );
}

export function PipelineScrollytelling({
  activeBeat,
  spineProgressRef,
  orbitalBgRef,
  registerBeatStop,
  onSelectBeat,
  onNextSection,
}: {
  activeBeat: number;
  spineProgressRef: RefObject<HTMLDivElement | null>;
  orbitalBgRef: RefObject<HTMLImageElement | null>;
  registerBeatStop: (beatIndex: number, el: HTMLDivElement | null) => void;
  onSelectBeat: (beatIndex: number) => void;
  onNextSection: () => void;
}) {
  return (
    <div id="architecture" className="relative h-[300dvh] w-full border-t border-border/60">
      {/* Pinned 100dvh stage — zero viewport bleed across all 3 scroll beats */}
      <div className="sticky top-0 z-10 flex h-[100dvh] w-full flex-col overflow-hidden pt-14">
        <div className="pointer-events-none absolute inset-0 overflow-hidden select-none">
          <img
            ref={orbitalBgRef}
            src="/images/orbital-horizon.jpg"
            alt=""
            aria-hidden="true"
            className="h-full w-full scale-105 object-cover object-center opacity-[0.14] will-change-transform dark:opacity-[0.22] [mask-image:radial-gradient(ellipse_80%_70%_at_55%_55%,black_20%,transparent_100%)]"
          />
          <div className="mission-grid absolute inset-0 opacity-45" />
        </div>

        <div className="relative z-10 mx-auto flex w-full max-w-6xl flex-1 flex-col justify-between px-4 py-6 sm:px-6 sm:py-9 md:py-11">
          {/* Crisp header */}
          <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-end">
            <div className="space-y-1.5">
              <p className="font-mono text-[10px] tracking-[0.22em] text-muted-foreground uppercase">
                01 // HOW IT WORKS
              </p>
              <h2 className="font-heading text-2xl leading-[1.04] font-semibold tracking-[0.04em] uppercase sm:text-4xl lg:text-5xl">
                Built for speed.
              </h2>
            </div>

            {/* Clean 3-tab selector on mobile (plenty of tap width even on 360px phones) */}
            <div className="grid grid-cols-3 gap-1.5 md:hidden">
              {PIPELINE_BEATS.map((beat, idx) => (
                <button
                  key={beat.step}
                  type="button"
                  onClick={() => onSelectBeat(idx)}
                  className={cn(
                    "border py-2 font-mono text-[10px] tracking-[0.12em] uppercase transition-colors",
                    activeBeat === idx
                      ? "border-foreground bg-foreground text-background"
                      : "border-border bg-transparent text-muted-foreground"
                  )}
                >
                  {beat.shortLabel}
                </button>
              ))}
            </div>
          </div>

          {/* Center split: Minimal 3-beat spine (left) + Live visual (right) */}
          <div className="grid min-h-0 flex-1 items-center gap-5 py-4 md:grid-cols-12 md:gap-10">
            {/* Desktop interactive 3-beat spine */}
            <div className="relative hidden flex-col gap-3 pl-5 md:col-span-5 md:flex">
              <div className="pointer-events-none absolute top-2 bottom-2 left-0 w-px bg-border/80">
                <div
                  ref={spineProgressRef}
                  className="h-full w-full origin-top bg-foreground will-change-transform"
                  style={{ transform: "scaleY(0.33)" }}
                />
              </div>

              {PIPELINE_BEATS.map((beat, idx) => {
                const isActive = activeBeat === idx;
                const isPassed = idx < activeBeat;
                return (
                  <button
                    key={beat.step}
                    type="button"
                    onClick={() => onSelectBeat(idx)}
                    className={cn(
                      "group relative w-full border px-4 py-3.5 text-left transition-all duration-300",
                      isActive
                        ? "border-foreground/50 bg-card/85 text-foreground"
                        : "border-transparent bg-transparent text-muted-foreground hover:border-border/70 hover:bg-card/40 hover:text-foreground/90"
                    )}
                  >
                    <span
                      className={cn(
                        "absolute top-1/2 -left-[23px] -translate-y-1/2 transition-all duration-300",
                        isActive
                          ? "size-2 bg-foreground"
                          : isPassed
                            ? "size-1.5 bg-foreground/60"
                            : "size-1.5 bg-border group-hover:bg-foreground/50"
                      )}
                    />
                    <span className="font-mono text-[10px] tracking-[0.16em] uppercase opacity-75">
                      {beat.step} · {beat.shortLabel}
                    </span>
                    <p className="mt-1 font-heading text-lg font-semibold tracking-[0.04em] uppercase">
                      {beat.headline}
                    </p>
                    <p
                      className={cn(
                        "mt-1 text-xs leading-relaxed transition-opacity duration-300",
                        isActive ? "text-muted-foreground opacity-100" : "text-muted-foreground/60 opacity-60"
                      )}
                    >
                      {beat.tagline}
                    </p>
                  </button>
                );
              })}
            </div>

            {/* Mobile active beat headline + 1-line tagline */}
            <div className="space-y-1 border-l-2 border-foreground pl-3.5 md:hidden">
              <h3 className="font-heading text-lg font-semibold tracking-[0.04em] uppercase">
                {PIPELINE_BEATS[activeBeat].headline}
              </h3>
              <p className="text-xs leading-relaxed text-muted-foreground">
                {PIPELINE_BEATS[activeBeat].tagline}
              </p>
            </div>

            {/* Right: Live morphing visual */}
            <div className="h-[250px] sm:h-[285px] md:col-span-7 md:h-[310px]">
              <PipelineTelemetryVisual activeBeat={activeBeat} />
            </div>
          </div>

          {/* Minimal footer bar */}
          <div className="flex items-center justify-between border-t border-border/70 pt-3 font-mono text-[10px] tracking-[0.16em] text-muted-foreground uppercase">
            <span>JAVA 21 · PGVECTOR · CLOUDFLARE AI</span>
            <button
              type="button"
              onClick={onNextSection}
              className="group inline-flex items-center gap-1.5 text-foreground/85 transition-colors hover:text-foreground"
            >
              <span>Benchmarks</span>
              <ArrowDown className="size-3 transition-transform duration-200 group-hover:translate-y-0.5" />
            </button>
          </div>
        </div>
      </div>

      {/* 3 invisible snap stops */}
      <div className="pointer-events-none absolute inset-x-0 top-0">
        {PIPELINE_BEATS.map((beat, idx) => (
          <div
            key={beat.step}
            ref={(el) => registerBeatStop(idx, el)}
            data-beat-index={idx}
            className="h-[100dvh] w-full snap-start snap-always"
          />
        ))}
      </div>
    </div>
  );
}
