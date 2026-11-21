"use client";

import type { RefObject } from "react";
import { ArrowDown } from "lucide-react";

import { SpotlightCard } from "@/components/landing/scroll-reveal";
import { cn } from "@/lib/utils";

export const PIPELINE_BEATS = [
  {
    step: "01",
    shortLabel: "INGEST",
    title: "Single-Pass Zipball & SHA Diff",
    metric: "1 HTTP/2 CALL · 0% RE-EMBEDS",
    body: "Streams the repository archive in one pass on Java 21 virtual threads. Strips binaries and lockfiles and compares blob SHAs so unchanged files never re-embed.",
  },
  {
    step: "02",
    shortLabel: "CHUNK",
    title: "Line-Boundary Scanner",
    metric: "1,600 CHARS · ~50% FEWER VECTORS",
    body: "Replaced heavy BPE tokenization with a single-pass line-aware scanner. Every segment preserves its file header and exact startLine–endLine coordinates.",
  },
  {
    step: "03",
    shortLabel: "BATCH",
    title: "Cross-File 64× Accumulator",
    metric: "108 → 31 CALLS · 3.5× FEWER",
    body: "Overrides Spring AI's 8K token-cap fragmentation with a fixed 64-doc BatchingStrategy that packs chunks across small files before calling Cloudflare bge-small-en-v1.5.",
  },
  {
    step: "04",
    shortLabel: "QUERY",
    title: "Direct Indexed Vector SQL",
    metric: "384-DIM HNSW + B-TREE EXPR",
    body: "Executes parameterized cosine similarity directly over a composite (repoId, userId) B-tree expression index—bypassing ORM casts and ANTLR filter overhead.",
  },
] as const;

const INGEST_FILES = [
  { path: "src/services/ChatStreamHandler.java", tag: "STREAM", dim: false },
  { path: "src/services/CodeContextRetriever.java", tag: "STREAM", dim: false },
  { path: "src/config/EmbeddingConfig.java", tag: "SHA MATCH · SKIP", dim: true },
  { path: "client/package-lock.json", tag: "FILTERED · NOISE", dim: true },
  { path: "src/services/IndexingService.java", tag: "STREAM", dim: false },
] as const;

const VECTOR_MATCHES = [
  { file: "ChatStreamHandler.java:318-356", score: 0.92, width: "92%" },
  { file: "CodeContextRetriever.java:139-172", score: 0.87, width: "87%" },
  { file: "EmbeddingConfig.java:56-69", score: 0.81, width: "81%" },
  { file: "ChatPromptBuilder.java:37-65", score: 0.74, width: "74%" },
] as const;

function PipelineTelemetryVisual({
  activeBeat,
}: {
  activeBeat: number;
}) {
  return (
    <SpotlightCard className="flex h-full flex-col justify-between border border-border/80 bg-card/75 p-4 backdrop-blur-md sm:p-5">
      {/* Stage header bar */}
      <div className="flex items-center justify-between border-b border-border/70 pb-3 font-mono text-[10px] tracking-[0.16em] text-muted-foreground uppercase">
        <div className="flex items-center gap-2">
          <span className="size-1.5 rounded-full bg-foreground" />
          <span>{`STAGE ${PIPELINE_BEATS[activeBeat].step} // ${PIPELINE_BEATS[activeBeat].shortLabel}`}</span>
        </div>
        <span className="tabular-telemetry text-foreground/85">
          {PIPELINE_BEATS[activeBeat].metric.split(" · ")[0]}
        </span>
      </div>

      {/* Live morphing visual viewport — all 4 stages occupy the same grid cell for zero shift */}
      <div className="relative my-3 grid flex-1 items-center sm:my-4">
        {/* BEAT 0: INGEST */}
        <div
          aria-hidden={activeBeat !== 0}
          className={cn(
            "col-start-1 row-start-1 space-y-2 transition-all duration-500 ease-out",
            activeBeat === 0
              ? "translate-y-0 opacity-100"
              : "pointer-events-none translate-y-3 opacity-0"
          )}
        >
          <div className="flex items-center justify-between font-mono text-[10px] tracking-[0.14em] text-muted-foreground uppercase">
            <span>HTTP/2 ZIPBALL STREAM</span>
            <span className="tabular-telemetry text-foreground">1,934 BLOBS · 160 MB SAFE</span>
          </div>
          <div className="divide-y divide-border/50 border border-border/70 bg-background/60">
            {INGEST_FILES.map((file, idx) => (
              <div
                key={file.path}
                style={{ transitionDelay: activeBeat === 0 ? `${idx * 55}ms` : "0ms" }}
                className={cn(
                  "flex items-center justify-between gap-2 px-3 py-2 font-mono text-[10px] transition-all duration-500 sm:text-[11px]",
                  activeBeat === 0 ? "translate-x-0 opacity-100" : "-translate-x-2 opacity-0",
                  file.dim ? "text-muted-foreground/55" : "text-foreground"
                )}
              >
                <span className="truncate">{file.path}</span>
                <span
                  className={cn(
                    "shrink-0 border px-1.5 py-0.5 text-[9px] tracking-[0.12em] uppercase",
                    file.dim
                      ? "border-border/50 text-muted-foreground/55"
                      : "border-foreground/35 text-foreground"
                  )}
                >
                  {file.tag}
                </span>
              </div>
            ))}
          </div>
        </div>

        {/* BEAT 1: CHUNK */}
        <div
          aria-hidden={activeBeat !== 1}
          className={cn(
            "col-start-1 row-start-1 space-y-2.5 transition-all duration-500 ease-out",
            activeBeat === 1
              ? "translate-y-0 opacity-100"
              : "pointer-events-none translate-y-3 opacity-0"
          )}
        >
          <div className="flex items-center justify-between font-mono text-[10px] tracking-[0.14em] text-muted-foreground uppercase">
            <span>SINGLE-PASS LINE BOUNDARIES</span>
            <span className="tabular-telemetry text-foreground">0 BPE OVERHEAD</span>
          </div>
          <div className="space-y-2">
            <div className="border-l-2 border-foreground bg-background/70 px-3 py-2.5 font-mono text-[10px] sm:text-[11px]">
              <div className="flex items-center justify-between text-[9px] tracking-[0.14em] text-muted-foreground uppercase">
                <span>CHUNK #01 · L01–L42</span>
                <span className="text-foreground">1,580 CHARS</span>
              </div>
              <pre className="mt-1.5 overflow-hidden text-foreground/90 leading-relaxed">
{`// File: src/services/CodeContextRetriever.java
public RetrievedContext retrieve(UUID userId, ...) {
  float[] vec = embeddingModel.embed(question);`}
              </pre>
            </div>
            <div className="border-l-2 border-border bg-background/45 px-3 py-2 font-mono text-[10px] text-muted-foreground sm:text-[11px]">
              <div className="flex items-center justify-between text-[9px] tracking-[0.14em] uppercase">
                <span>CHUNK #02 · L43–L86</span>
                <span>1,596 CHARS</span>
              </div>
              <p className="mt-1 truncate">
                {"// File: src/services/CodeContextRetriever.java · directIndexedVectorSearch(...)"}
              </p>
            </div>
          </div>
        </div>

        {/* BEAT 2: BATCH / VECTORIZE */}
        <div
          aria-hidden={activeBeat !== 2}
          className={cn(
            "col-start-1 row-start-1 space-y-3 transition-all duration-500 ease-out",
            activeBeat === 2
              ? "translate-y-0 opacity-100"
              : "pointer-events-none translate-y-3 opacity-0"
          )}
        >
          <div className="space-y-1.5">
            <div className="flex items-center justify-between font-mono text-[10px] tracking-[0.14em] text-muted-foreground uppercase">
              <span>BEFORE · DEFAULT TOKEN SPLITTER</span>
              <span className="tabular-telemetry line-through opacity-70">108 CALLS (18–22 / CALL)</span>
            </div>
            <div className="grid grid-cols-12 gap-1 opacity-45">
              {Array.from({ length: 12 }).map((_, i) => (
                <div
                  key={i}
                  className="h-3 border border-border bg-muted/40"
                />
              ))}
            </div>
          </div>

          <div className="space-y-1.5">
            <div className="flex items-center justify-between font-mono text-[10px] tracking-[0.14em] text-foreground uppercase">
              <span>AFTER · CROSS-FILE 64× BATCHER</span>
              <span className="tabular-telemetry font-semibold">31 CALLS · 3.5× FEWER</span>
            </div>
            <div className="grid grid-cols-4 gap-1.5">
              {[64, 64, 64, 64].map((size, idx) => (
                <div
                  key={idx}
                  style={{ transitionDelay: activeBeat === 2 ? `${idx * 75}ms` : "0ms" }}
                  className={cn(
                    "flex h-10 flex-col items-center justify-center border border-foreground/70 bg-foreground/[0.08] font-mono transition-all duration-500",
                    activeBeat === 2 ? "scale-100 opacity-100" : "scale-95 opacity-0"
                  )}
                >
                  <span className="tabular-telemetry text-xs font-semibold text-foreground">{size}</span>
                  <span className="text-[8px] tracking-[0.12em] text-muted-foreground uppercase">CHUNKS</span>
                </div>
              ))}
            </div>
          </div>

          <div className="flex items-center justify-between border-t border-border/60 pt-2 font-mono text-[10px] text-muted-foreground">
            <span>@cf/baai/bge-small-en-v1.5</span>
            <span className="tabular-telemetry text-foreground">384-DIM FLOAT32</span>
          </div>
        </div>

        {/* BEAT 3: DIRECT INDEXED SQL */}
        <div
          aria-hidden={activeBeat !== 3}
          className={cn(
            "col-start-1 row-start-1 space-y-3 transition-all duration-500 ease-out",
            activeBeat === 3
              ? "translate-y-0 opacity-100"
              : "pointer-events-none translate-y-3 opacity-0"
          )}
        >
          <div className="border border-border/70 bg-background/70 px-3 py-2 font-mono text-[10px] leading-relaxed text-muted-foreground">
            <span className="text-foreground">WHERE</span> (metadata-&gt;&gt;&apos;repoId&apos;) = $1{" "}
            <span className="text-foreground">AND</span> (embedding &lt;=&gt; $2) &lt;= 0.65{" "}
            <span className="text-foreground">LIMIT</span> 5
          </div>

          <div className="space-y-2">
            {VECTOR_MATCHES.map((m, idx) => (
              <div key={m.file} className="space-y-1">
                <div className="flex items-center justify-between font-mono text-[10px]">
                  <span className="truncate text-foreground/90">{m.file}</span>
                  <span className="tabular-telemetry text-foreground">{m.score.toFixed(2)}</span>
                </div>
                <div className="h-[3px] w-full bg-border/60">
                  <div
                    data-visible={activeBeat === 3 ? "true" : "false"}
                    style={{
                      width: m.width,
                      transitionDelay: activeBeat === 3 ? `${idx * 80}ms` : "0ms",
                    }}
                    className="metric-bar-fill h-full bg-foreground"
                  />
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Bottom continuous stage progress bar */}
      <div className="flex items-center justify-between border-t border-border/70 pt-3 font-mono text-[10px] tracking-[0.14em] text-muted-foreground uppercase">
        <span>BEAT 0{activeBeat + 1} / 04</span>
        <div className="flex items-center gap-1.5">
          {PIPELINE_BEATS.map((b, i) => (
            <span
              key={b.step}
              className={cn(
                "block h-[2px] transition-all duration-300",
                i <= activeBeat ? "w-5 bg-foreground" : "w-2.5 bg-border"
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
    <div id="architecture" className="relative h-[400dvh] w-full border-t border-border/60">
      {/* Sticky full-viewport stage locked to 100dvh across all 4 scroll beats (zero bleed!) */}
      <div className="sticky top-0 z-10 flex h-[100dvh] w-full flex-col overflow-hidden pt-14">
        <div className="pointer-events-none absolute inset-0 overflow-hidden select-none">
          <img
            ref={orbitalBgRef}
            src="/images/orbital-horizon.jpg"
            alt=""
            aria-hidden="true"
            className="h-full w-full scale-105 object-cover object-center opacity-[0.07] contrast-125 will-change-transform dark:opacity-[0.12] [mask-image:radial-gradient(ellipse_75%_65%_at_50%_55%,black_15%,transparent_100%)]"
          />
          <div className="mission-grid absolute inset-0 opacity-45" />
        </div>

        <div className="relative z-10 mx-auto flex w-full max-w-6xl flex-1 flex-col justify-between px-4 py-5 sm:px-6 sm:py-8 md:py-10">
          {/* Header */}
          <div className="flex flex-col justify-between gap-2 sm:flex-row sm:items-end">
            <div className="max-w-xl space-y-1.5 sm:space-y-2.5">
              <p className="font-mono text-[10px] tracking-[0.22em] text-muted-foreground uppercase sm:text-[11px]">
                01 // UNDER THE HOOD — SCROLLYTELLING PIPELINE
              </p>
              <h2 className="font-heading text-2xl leading-[1.05] font-semibold tracking-[0.04em] uppercase sm:text-4xl lg:text-[2.75rem]">
                Engineered for a 160 MB heap.
              </h2>
            </div>

            {/* Mobile compact beat switcher pills */}
            <div className="flex items-center gap-1.5 md:hidden">
              {PIPELINE_BEATS.map((beat, idx) => (
                <button
                  key={beat.step}
                  type="button"
                  onClick={() => onSelectBeat(idx)}
                  className={cn(
                    "border px-2.5 py-1 font-mono text-[10px] tracking-[0.14em] uppercase transition-colors",
                    activeBeat === idx
                      ? "border-foreground bg-foreground text-background"
                      : "border-border bg-transparent text-muted-foreground"
                  )}
                >
                  {beat.step}
                </button>
              ))}
            </div>
          </div>

          {/* Center split: Left progressive narrative spine + Right live telemetry stage */}
          <div className="grid min-h-0 flex-1 items-center gap-4 py-3 md:grid-cols-12 md:gap-8 md:py-5">
            {/* Desktop narrative timeline (all 4 beats with live scroll-filled vertical spine) */}
            <div className="relative hidden flex-col gap-2.5 pl-5 md:col-span-6 md:flex">
              {/* Vertical track + scroll-driven active fill */}
              <div className="pointer-events-none absolute top-2 bottom-2 left-0 w-px bg-border/80">
                <div
                  ref={spineProgressRef}
                  className="h-full w-full origin-top bg-foreground will-change-transform"
                  style={{ transform: "scaleY(0.25)" }}
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
                      "group relative w-full border px-4 py-3 text-left transition-all duration-300",
                      isActive
                        ? "border-foreground/50 bg-card/85 text-foreground"
                        : "border-transparent bg-transparent text-muted-foreground hover:border-border/70 hover:bg-card/40 hover:text-foreground/90"
                    )}
                  >
                    {/* Active indicator node on spine */}
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
                    <div className="flex items-center justify-between gap-2 font-mono text-[10px] tracking-[0.16em] uppercase">
                      <span className={isActive ? "text-foreground" : "text-muted-foreground"}>
                        {beat.step} · {beat.shortLabel}
                      </span>
                      <span className="tabular-telemetry text-[9px] text-muted-foreground">
                        {beat.metric}
                      </span>
                    </div>
                    <p className="mt-1 font-heading text-sm font-semibold tracking-[0.06em] uppercase">
                      {beat.title}
                    </p>
                    <div
                      className={cn(
                        "grid transition-all duration-300 ease-out",
                        isActive ? "mt-1.5 grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-0"
                      )}
                    >
                      <p className="overflow-hidden text-xs leading-relaxed text-muted-foreground">
                        {beat.body}
                      </p>
                    </div>
                  </button>
                );
              })}
            </div>

            {/* Mobile active beat copy */}
            <div className="space-y-1.5 border-l-2 border-foreground pl-3 md:hidden">
              <div className="flex items-center justify-between gap-2 font-mono text-[10px] tracking-[0.14em] text-muted-foreground uppercase">
                <span>{PIPELINE_BEATS[activeBeat].step} · {PIPELINE_BEATS[activeBeat].shortLabel}</span>
                <span className="tabular-telemetry text-foreground/80">
                  {PIPELINE_BEATS[activeBeat].metric.split(" · ")[0]}
                </span>
              </div>
              <h3 className="font-heading text-sm font-semibold tracking-[0.06em] uppercase">
                {PIPELINE_BEATS[activeBeat].title}
              </h3>
              <p className="text-[11px] leading-relaxed text-muted-foreground">
                {PIPELINE_BEATS[activeBeat].body}
              </p>
            </div>

            {/* Right: Live morphing telemetry visualization */}
            <div className="h-[250px] sm:h-[290px] md:col-span-6 md:h-[340px]">
              <PipelineTelemetryVisual activeBeat={activeBeat} />
            </div>
          </div>

          {/* Bottom strip */}
          <div className="flex items-center justify-between gap-3 border-t border-border/70 pt-3 font-mono text-[10px] tracking-[0.16em] text-muted-foreground uppercase">
            <span className="hidden sm:inline">
              SCROLL TO ADVANCE PIPELINE · CLICK ANY STAGE TO INSPECT
            </span>
            <span className="sm:hidden">SCROLL TO ADVANCE</span>
            <button
              type="button"
              onClick={onNextSection}
              className="group inline-flex items-center gap-1.5 text-foreground/85 transition-colors hover:text-foreground"
            >
              <span>Runtime</span>
              <ArrowDown className="size-3 transition-transform duration-200 group-hover:translate-y-0.5" />
            </button>
          </div>
        </div>
      </div>

      {/* 4 invisible full-viewport snap stops stacked cleanly over the 400dvh track */}
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
