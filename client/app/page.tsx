"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowDown, ArrowRight, ArrowUp, ArrowUpRight, Mail } from "lucide-react";

import { BrandMark } from "@/components/layout/app-shell";
import {
  Reveal,
  SignatureTypewriter,
  usePrefersReducedMotion,
} from "@/components/landing/scroll-reveal";
import { ModeToggle } from "@/components/ui/mode-toggle";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api";

const SECTIONS = [
  { id: "hero", num: "01", label: "Launch" },
  { id: "architecture", num: "02", label: "Pipeline" },
  { id: "latency", num: "03", label: "Runtime" },
  { id: "edge", num: "04", label: "Edge" },
  { id: "signature", num: "05", label: "Author" },
] as const;

const HERO_SPECS = [
  {
    index: "01",
    title: "INGEST",
    metric: "1-PASS · 0 RE-EMBEDS",
    body: "Single-pass archive streaming on virtual threads. Skips 100% of unchanged files on re-index.",
  },
  {
    index: "02",
    title: "VECTORIZE",
    metric: "64× BATCH · 384-DIM",
    body: "Cross-file 64-chunk batches over HNSW cosine indexes — 3.5× fewer inference round-trips.",
  },
  {
    index: "03",
    title: "INTERROGATE",
    metric: "4-TIER · 5 MODELS",
    body: "Adaptive retrieval with 5-model failover, streaming answers locked to exact file:line ranges.",
  },
] as const;

const PIPELINE_STAGES = [
  {
    step: "01",
    title: "SHA-Diff Zipball Stream",
    metric: "1 HTTP/2 CALL",
    body: "Streams repository archives in one pass, strips binaries and lockfiles, and hashes blobs so unchanged files never re-embed.",
  },
  {
    step: "02",
    title: "Line-Boundary Chunker",
    metric: "1,600 CHARS",
    body: "Replaced BPE tokenization with a single-pass line scanner—cutting vector count ~50% while tracking exact start and end lines.",
  },
  {
    step: "03",
    title: "Cross-File 64× Batcher",
    metric: "108 → 31 CALLS",
    body: "Custom fixed-size BatchingStrategy accumulates chunks across small files before calling Cloudflare bge-small-en-v1.5.",
  },
  {
    step: "04",
    title: "Indexed Direct SQL",
    metric: "HNSW + B-TREE",
    body: "Bypasses ORM metadata casts and ANTLR filter parsing with parameterized cosine search on a composite repo/user expression index.",
  },
] as const;

const LATENCY_PILLARS = [
  {
    label: "4-TIER QUERY ROUTING",
    body: "Trivial turns skip RAG (0 ms). Direct lookups hit llama-3.1-8b-instant in 1–3 sentences; architectural traces scale context to llama-3.3-70b-versatile.",
  },
  {
    label: "ZERO-BLOCKING SSE PATH",
    body: "Streams open immediately with 4 s heartbeats. ChatContextCache validates sessions in 0 ms while messages persist off-path via batched JDBC.",
  },
  {
    label: "5-MODEL CIRCUIT BREAKER",
    body: "Per-model cooldowns (429 → 5 m, 503 → 60 s) step across four Groq models down to Gemini 2.5 Flash without retrying degraded endpoints.",
  },
] as const;

const BENCHMARKS = [
  { label: "Embedding Calls (1,934 chunks)", before: "108", after: "31 (3.5×)" },
  { label: "Unchanged File Re-Embeds", before: "100%", after: "0%" },
  { label: "Pre-RAG Session Lookup", before: "Sync DB", after: "0 ms cache" },
  { label: "Client Stream Commits", before: "Per token", after: "60 fps rAF" },
  { label: "Container Memory Envelope", before: "Unbounded", after: "160 MB heap" },
] as const;

const EDGE_POINTS = [
  {
    num: "01",
    title: "Zero Auth Friction",
    tag: "INSTANT ENTRY",
    body: "Paste any public repository URL and interrogate it immediately. Workspace isolation runs via scoped headers—no OAuth walls or org approvals.",
  },
  {
    num: "02",
    title: "Exposed RAG & LLM Controls",
    tag: "5 LIVE KNOBS",
    body: "Temperature, Max Tokens (256–4096), Top-K (1–10), Similarity Threshold (0–1), and System Prompt sit beside chat and execute directly in SQL and provider calls.",
  },
  {
    num: "03",
    title: "Verifiable Source Coordinates",
    tag: "FILE:LINE LOCKED",
    body: "Every embedded segment retains file path and exact line bounds. Responses anchor to clickable GitHub line ranges rather than ungrounded summaries.",
  },
  {
    num: "04",
    title: "Proportional Responses",
    tag: "NO ESSAY WALLS",
    body: "Answer depth follows question complexity. A config lookup returns two direct sentences; an end-to-end trace returns a structured walkthrough.",
  },
] as const;

export default function HomePage() {
  const [repoUrl, setRepoUrl] = useState("");
  const [error, setError] = useState("");
  const [isClicked, setIsClicked] = useState(false);
  const [activeSection, setActiveSection] = useState(0);
  const [revealed, setRevealed] = useState<boolean[]>([true, false, false, false, false]);

  const hasClickedRef = useRef(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const scrollRootRef = useRef<HTMLDivElement>(null);
  const sectionRefs = useRef<(HTMLElement | null)[]>([]);
  const reducedMotion = usePrefersReducedMotion();
  const router = useRouter();

  // Wake a sleeping Render backend while the user is exploring or pasting a GitHub URL
  useEffect(() => {
    void fetch("/backend/api/health", { cache: "no-store" }).catch(() => {});
  }, []);

  // Observe section visibility inside the dedicated 100dvh snap container
  useEffect(() => {
    const root = scrollRootRef.current;
    if (!root) return;

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          const idx = Number((entry.target as HTMLElement).dataset.sectionIndex);
          if (Number.isNaN(idx)) continue;
          setActiveSection(idx);
          setRevealed((prev) => {
            if (prev[idx]) return prev;
            const next = [...prev];
            next[idx] = true;
            return next;
          });
        }
      },
      {
        root,
        threshold: 0.45,
      }
    );

    for (const el of sectionRefs.current) {
      if (el) observer.observe(el);
    }

    return () => observer.disconnect();
  }, []);

  const scrollToSection = useCallback(
    (index: number, focusInput = false) => {
      const target = sectionRefs.current[index];
      if (!target) return;
      target.scrollIntoView({
        behavior: reducedMotion ? "auto" : "smooth",
        block: "start",
      });
      if (focusInput) {
        window.setTimeout(() => inputRef.current?.focus(), reducedMotion ? 50 : 480);
      }
    },
    [reducedMotion]
  );

  function analyze() {
    if (hasClickedRef.current) return;

    if (!repoUrl.trim()) {
      inputRef.current?.focus();
      setError("Enter a valid GitHub repository URL");
      return;
    }

    const match = repoUrl.trim().match(/github\.com\/([^/]+)\/([^/?#]+)/i);
    if (!match) {
      hasClickedRef.current = false;
      setIsClicked(false);
      setError("Enter a valid GitHub repository URL");
      return;
    }

    const owner = match[1];
    const name = match[2].replace(/\.git$/, "");
    const canonicalUrl = `https://github.com/${owner}/${name}`;
    const slug = `${owner}-${name}`.toLowerCase();
    hasClickedRef.current = true;
    router.push(`/chat/${slug}?url=${encodeURIComponent(canonicalUrl)}`);
    setIsClicked(true);
    setError("");
    void api.analyzeRepo(canonicalUrl).catch((err) => {
      setError(err instanceof Error ? err.message : "Could not analyze repository");
    });
  }

  return (
    <div className="relative h-[100dvh] w-full overflow-hidden bg-background text-foreground">
      {/* Fixed top mission bar */}
      <header className="fixed inset-x-0 top-0 z-40 h-14 border-b border-border/80 bg-background/75 backdrop-blur-md">
        <div className="mx-auto flex h-full w-full max-w-6xl items-center justify-between px-4 sm:px-6">
          <button
            type="button"
            onClick={() => scrollToSection(0)}
            aria-label="Scroll to top"
            className="text-left focus-visible:outline-none"
          >
            <BrandMark />
          </button>

          <div className="flex items-center gap-4 sm:gap-5">
            <span className="tabular-telemetry hidden font-mono text-[10px] tracking-[0.18em] text-muted-foreground uppercase md:inline">
              {SECTIONS[activeSection]?.num} / 0{SECTIONS.length} · {SECTIONS[activeSection]?.label}
            </span>
            <span className="hidden items-center gap-2 font-mono text-[10px] tracking-[0.18em] text-muted-foreground uppercase sm:inline-flex">
              <span className="size-1.5 rounded-full bg-foreground/80" />
              SYS // NOMINAL
            </span>
            <Link
              href="/dashboard"
              className="font-heading text-xs font-semibold tracking-[0.16em] text-muted-foreground uppercase transition-colors hover:text-foreground"
            >
              Console
            </Link>
            <ModeToggle />
          </div>
        </div>
      </header>

      {/* Whisper-quiet right-edge section rail (desktop) */}
      <nav
        aria-label="Page sections"
        className="fixed top-1/2 right-5 z-30 hidden -translate-y-1/2 flex-col items-end gap-3 lg:flex"
      >
        {SECTIONS.map((sec, idx) => {
          const isActive = activeSection === idx;
          return (
            <button
              key={sec.id}
              type="button"
              onClick={() => scrollToSection(idx)}
              aria-label={`Jump to ${sec.label}`}
              aria-current={isActive ? "true" : undefined}
              className="group flex items-center gap-2 py-1"
            >
              <span
                className={`font-mono text-[9px] tracking-[0.18em] uppercase transition-opacity duration-200 ${
                  isActive
                    ? "text-foreground opacity-100"
                    : "text-muted-foreground opacity-0 group-hover:opacity-80"
                }`}
              >
                {sec.num}
              </span>
              <span
                className={`block h-px transition-all duration-300 ${
                  isActive
                    ? "w-6 bg-foreground"
                    : "w-3 bg-border group-hover:w-5 group-hover:bg-foreground/60"
                }`}
              />
            </button>
          );
        })}
      </nav>

      {/* Strict 100dvh mandatory snap-scroll viewport root */}
      <div
        ref={scrollRootRef}
        className="h-[100dvh] w-full snap-y snap-mandatory overflow-x-hidden overflow-y-auto scroll-smooth"
      >
        {/* =====================================================================
            SECTION 01 — HERO
           ===================================================================== */}
        <section
          id="hero"
          data-section-index={0}
          ref={(el) => {
            sectionRefs.current[0] = el;
          }}
          className="relative flex h-[100dvh] w-full snap-start snap-always flex-col overflow-hidden pt-14"
        >
          {/* Real monochrome SpaceX night-launch photography */}
          <div className="pointer-events-none absolute inset-0 overflow-hidden select-none">
            <img
              src="/images/spacex-launch-arc.jpg"
              alt=""
              aria-hidden="true"
              className="h-full w-full object-cover object-[72%_35%] opacity-[0.22] contrast-125 sm:object-right-bottom dark:opacity-[0.30] [mask-image:radial-gradient(ellipse_80%_75%_at_75%_55%,black_25%,transparent_100%)]"
            />
            <div className="mission-grid absolute inset-0 opacity-60" />
          </div>

          <main className="relative z-10 mx-auto flex w-full max-w-6xl flex-1 flex-col justify-between px-4 py-6 sm:px-6 sm:py-10 md:py-12">
            <div className="max-w-2xl space-y-4 pt-2 sm:space-y-6 sm:pt-4 md:pt-8">
              <div className="space-y-2.5 sm:space-y-4">
                <p className="font-mono text-[10px] tracking-[0.22em] text-muted-foreground uppercase sm:text-[11px]">
                  00 // CODEBASE TELEMETRY ENGINE
                </p>
                <h1 className="font-heading text-[2rem] leading-[1.02] font-semibold tracking-[0.04em] uppercase sm:text-5xl lg:text-6xl">
                  Interrogate Any Repository.
                </h1>
                <p className="max-w-lg text-xs leading-relaxed text-muted-foreground sm:text-base">
                  Stream public GitHub source trees into vector space and query architecture,
                  execution paths, and symbols with line-level citations.
                </p>
              </div>

              {/* Launch command input bar */}
              <div className="space-y-2.5 pt-1 sm:space-y-3 sm:pt-2">
                <div className="flex flex-col border border-input bg-background/85 backdrop-blur-sm transition-colors focus-within:border-foreground sm:flex-row">
                  <div className="flex min-w-0 flex-1 items-center">
                    <div className="flex shrink-0 items-center border-r border-border/70 px-3 py-2 font-mono text-[11px] tracking-[0.12em] text-muted-foreground uppercase sm:px-3.5">
                      GIT
                    </div>
                    <input
                      ref={inputRef}
                      value={repoUrl}
                      onChange={(event) => {
                        setRepoUrl(event.target.value);
                        if (error) setError("");
                      }}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") analyze();
                      }}
                      placeholder="https://github.com/owner/repository"
                      aria-label="GitHub repository URL"
                      className="h-11 min-w-0 flex-1 bg-transparent px-3 font-mono text-xs tracking-wide text-foreground outline-none placeholder:text-muted-foreground/60 sm:h-12 sm:px-4 sm:text-sm"
                    />
                  </div>
                  <Button
                    variant="outline"
                    size="lg"
                    onClick={analyze}
                    disabled={isClicked}
                    className={`h-11 rounded-none border-0 border-t border-input bg-transparent px-7 text-foreground hover:bg-foreground hover:text-background sm:h-12 sm:border-t-0 sm:border-l ${
                      isClicked ? "pointer-events-none opacity-60" : ""
                    }`}
                  >
                    Analyze
                    <ArrowRight
                      className={`size-3.5 transition-transform duration-200 ${
                        isClicked ? "translate-x-1" : "group-hover/button:translate-x-0.5"
                      }`}
                    />
                  </Button>
                </div>
                {error ? (
                  <p role="alert" className="font-mono text-xs tracking-wide text-destructive">
                    ERR // {error}
                  </p>
                ) : (
                  <p className="font-mono text-[10px] tracking-[0.12em] text-muted-foreground/80 uppercase sm:text-[11px]">
                    PUBLIC REPOSITORIES · ZERO AUTH REQUIRED · PRESS ENTER TO INITIATE
                  </p>
                )}
              </div>
            </div>

            {/* Bottom telemetry strip + understated scroll indicator */}
            <div className="space-y-4 sm:space-y-6">
              <div className="grid gap-3 border-t border-border/80 pt-4 sm:gap-6 sm:pt-6 md:grid-cols-3">
                {HERO_SPECS.map((item) => (
                  <div key={item.index} className="space-y-1 sm:space-y-2">
                    <div className="flex items-center justify-between gap-2 font-mono text-[10px] tracking-[0.2em] text-muted-foreground sm:text-[11px]">
                      <div className="flex items-center gap-2.5">
                        <span>{item.index}</span>
                        <span className="h-px w-5 bg-border" />
                        <span className="font-heading text-xs font-semibold tracking-[0.18em] text-foreground">
                          {item.title}
                        </span>
                      </div>
                      <span className="tabular-telemetry text-[9px] tracking-[0.12em] text-muted-foreground/75 uppercase sm:text-[10px]">
                        {item.metric}
                      </span>
                    </div>
                    <p className="text-[11px] leading-relaxed text-muted-foreground sm:text-xs">
                      {item.body}
                    </p>
                  </div>
                ))}
              </div>

              <div className="flex items-center justify-between">
                <button
                  type="button"
                  onClick={() => scrollToSection(1)}
                  className="group inline-flex items-center gap-2 font-mono text-[10px] tracking-[0.2em] text-muted-foreground uppercase transition-colors hover:text-foreground"
                >
                  <span>Architecture</span>
                  <ArrowDown className="size-3 transition-transform duration-300 group-hover:translate-y-0.5" />
                </button>
                <span className="hidden font-mono text-[10px] tracking-[0.16em] text-muted-foreground/60 uppercase sm:inline">
                  SCROLL TO INSPECT
                </span>
              </div>
            </div>
          </main>
        </section>

        {/* =====================================================================
            SECTION 02 — UNDER THE HOOD I (INGESTION & VECTOR ARCHITECTURE)
           ===================================================================== */}
        <section
          id="architecture"
          data-section-index={1}
          ref={(el) => {
            sectionRefs.current[1] = el;
          }}
          className="relative flex h-[100dvh] w-full snap-start snap-always flex-col overflow-hidden border-t border-border/60 pt-14"
        >
          <div className="pointer-events-none absolute inset-0 overflow-hidden select-none">
            <img
              src="/images/orbital-horizon.jpg"
              alt=""
              aria-hidden="true"
              className="h-full w-full object-cover object-center opacity-[0.07] contrast-125 dark:opacity-[0.11] [mask-image:radial-gradient(ellipse_75%_65%_at_50%_55%,black_15%,transparent_100%)]"
            />
            <div className="mission-grid absolute inset-0 opacity-45" />
          </div>

          <div className="relative z-10 mx-auto flex w-full max-w-6xl flex-1 flex-col justify-between px-4 py-6 sm:px-6 sm:py-10 md:py-12">
            <Reveal visible={revealed[1]} className="max-w-2xl space-y-2.5 sm:space-y-3.5">
              <p className="font-mono text-[10px] tracking-[0.22em] text-muted-foreground uppercase sm:text-[11px]">
                01 // UNDER THE HOOD — PIPELINE
              </p>
              <h2 className="font-heading text-2xl leading-[1.06] font-semibold tracking-[0.04em] uppercase sm:text-4xl lg:text-5xl">
                Engineered for a 160 MB heap.
              </h2>
              <p className="text-xs leading-relaxed text-muted-foreground sm:text-sm">
                Running Spring Boot, concurrent GitHub ingestion, and vector search on a
                constrained container leaves zero margin for naive defaults. Every stage is
                streaming, diff-aware, and bounded in memory.
              </p>
            </Reveal>

            <div className="grid gap-2.5 sm:grid-cols-2 sm:gap-4 lg:grid-cols-4">
              {PIPELINE_STAGES.map((stage, i) => (
                <Reveal
                  key={stage.step}
                  visible={revealed[1]}
                  delay={90 + i * 70}
                  className="flex flex-col justify-between border border-border/80 bg-card/70 p-3.5 backdrop-blur-sm sm:p-5"
                >
                  <div className="space-y-2 sm:space-y-3">
                    <div className="flex items-center justify-between gap-2 font-mono text-[10px] tracking-[0.16em] text-muted-foreground uppercase">
                      <span>{stage.step}</span>
                      <span className="tabular-telemetry text-foreground/80">
                        {stage.metric}
                      </span>
                    </div>
                    <h3 className="font-heading text-xs font-semibold tracking-[0.1em] text-foreground uppercase sm:text-sm">
                      {stage.title}
                    </h3>
                    <p className="text-[11px] leading-relaxed text-muted-foreground sm:text-xs">
                      {stage.body}
                    </p>
                  </div>
                </Reveal>
              ))}
            </div>

            <Reveal
              visible={revealed[1]}
              delay={380}
              className="flex flex-wrap items-center justify-between gap-3 border-t border-border/70 pt-3 font-mono text-[10px] tracking-[0.16em] text-muted-foreground uppercase sm:pt-4"
            >
              <div className="flex flex-wrap items-center gap-x-5 gap-y-1">
                <span>JAVA 21 VIRTUAL THREADS</span>
                <span>CLOUDFLARE BGE-SMALL-EN-V1.5</span>
                <span>NEON POSTGRES + PGVECTOR</span>
              </div>
              <button
                type="button"
                onClick={() => scrollToSection(2)}
                className="inline-flex items-center gap-1.5 text-foreground/80 transition-colors hover:text-foreground"
              >
                <span>Runtime</span>
                <ArrowDown className="size-3" />
              </button>
            </Reveal>
          </div>
        </section>

        {/* =====================================================================
            SECTION 03 — UNDER THE HOOD II (LATENCY & RUNTIME BENCHMARKS)
           ===================================================================== */}
        <section
          id="latency"
          data-section-index={2}
          ref={(el) => {
            sectionRefs.current[2] = el;
          }}
          className="relative flex h-[100dvh] w-full snap-start snap-always flex-col overflow-hidden border-t border-border/60 pt-14"
        >
          <div className="mission-grid pointer-events-none absolute inset-0 opacity-40" />

          <div className="relative z-10 mx-auto flex w-full max-w-6xl flex-1 flex-col justify-between px-4 py-6 sm:px-6 sm:py-10 md:py-12">
            <Reveal visible={revealed[2]} className="max-w-2xl space-y-2 sm:space-y-3">
              <p className="font-mono text-[10px] tracking-[0.22em] text-muted-foreground uppercase sm:text-[11px]">
                02 // UNDER THE HOOD — RUNTIME
              </p>
              <h2 className="font-heading text-2xl leading-[1.06] font-semibold tracking-[0.04em] uppercase sm:text-4xl lg:text-5xl">
                Latency cut at every hop.
              </h2>
            </Reveal>

            <div className="grid items-start gap-5 lg:grid-cols-12 lg:gap-8">
              {/* Left: Runtime architecture pillars */}
              <div className="space-y-3 sm:space-y-4 lg:col-span-6">
                {LATENCY_PILLARS.map((item, i) => (
                  <Reveal
                    key={item.label}
                    visible={revealed[2]}
                    delay={80 + i * 75}
                    className="border-l border-border pl-3.5 sm:pl-4"
                  >
                    <p className="font-mono text-[10px] font-medium tracking-[0.16em] text-foreground uppercase sm:text-[11px]">
                      {item.label}
                    </p>
                    <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground sm:text-xs">
                      {item.body}
                    </p>
                  </Reveal>
                ))}
              </div>

              {/* Right: Concrete Before -> After ledger */}
              <Reveal
                visible={revealed[2]}
                delay={220}
                className="border border-border/80 bg-card/70 lg:col-span-6"
              >
                <div className="grid grid-cols-[1.4fr_0.75fr_0.85fr] border-b border-border/80 px-3.5 py-2 font-mono text-[9px] tracking-[0.18em] text-muted-foreground uppercase sm:px-4 sm:py-2.5 sm:text-[10px]">
                  <span>Metric</span>
                  <span>Before</span>
                  <span className="text-right text-foreground">After</span>
                </div>
                <div className="divide-y divide-border/60">
                  {BENCHMARKS.map((row) => (
                    <div
                      key={row.label}
                      className="grid grid-cols-[1.4fr_0.75fr_0.85fr] items-center gap-2 px-3.5 py-2 font-mono text-[10px] sm:px-4 sm:py-3 sm:text-xs"
                    >
                      <span className="truncate text-muted-foreground">{row.label}</span>
                      <span className="tabular-telemetry text-muted-foreground/65 line-through decoration-border">
                        {row.before}
                      </span>
                      <span className="tabular-telemetry text-right font-medium text-foreground">
                        {row.after}
                      </span>
                    </div>
                  ))}
                </div>
              </Reveal>
            </div>

            <Reveal
              visible={revealed[2]}
              delay={340}
              className="flex items-center justify-between border-t border-border/70 pt-3 font-mono text-[10px] tracking-[0.16em] text-muted-foreground uppercase sm:pt-4"
            >
              <span>MEASURED ON PRODUCTION INDEXING &amp; SSE TRACES</span>
              <button
                type="button"
                onClick={() => scrollToSection(3)}
                className="inline-flex items-center gap-1.5 text-foreground/80 transition-colors hover:text-foreground"
              >
                <span>The Edge</span>
                <ArrowDown className="size-3" />
              </button>
            </Reveal>
          </div>
        </section>

        {/* =====================================================================
            SECTION 04 — THE EDGE (DIFFERENTIATION)
           ===================================================================== */}
        <section
          id="edge"
          data-section-index={3}
          ref={(el) => {
            sectionRefs.current[3] = el;
          }}
          className="relative flex h-[100dvh] w-full snap-start snap-always flex-col overflow-hidden border-t border-border/60 pt-14"
        >
          <div className="mission-grid pointer-events-none absolute inset-0 opacity-35" />

          <div className="relative z-10 mx-auto flex w-full max-w-6xl flex-1 flex-col justify-between px-4 py-6 sm:px-6 sm:py-10 md:py-12">
            <Reveal visible={revealed[3]} className="max-w-2xl space-y-2 sm:space-y-3">
              <p className="font-mono text-[10px] tracking-[0.22em] text-muted-foreground uppercase sm:text-[11px]">
                03 // THE EDGE
              </p>
              <h2 className="font-heading text-2xl leading-[1.06] font-semibold tracking-[0.04em] uppercase sm:text-4xl lg:text-5xl">
                Precision over black-box wrappers.
              </h2>
              <p className="text-xs leading-relaxed text-muted-foreground sm:text-sm">
                Most repository chat tools hide retrieval knobs behind generic presets and
                answer one-line lookups with five-section essays. TRACE treats retrieval as a
                transparent engineering instrument.
              </p>
            </Reveal>

            <div className="grid gap-2.5 sm:grid-cols-2 sm:gap-4">
              {EDGE_POINTS.map((point, i) => (
                <Reveal
                  key={point.num}
                  visible={revealed[3]}
                  delay={80 + i * 70}
                  className="border border-border/80 bg-card/60 p-3.5 sm:p-5"
                >
                  <div className="flex items-center justify-between gap-2 font-mono text-[10px] tracking-[0.16em] text-muted-foreground uppercase">
                    <span>{point.num}</span>
                    <span className="text-foreground/75">{point.tag}</span>
                  </div>
                  <h3 className="mt-2 font-heading text-xs font-semibold tracking-[0.1em] text-foreground uppercase sm:text-sm">
                    {point.title}
                  </h3>
                  <p className="mt-1.5 text-[11px] leading-relaxed text-muted-foreground sm:text-xs">
                    {point.body}
                  </p>
                </Reveal>
              ))}
            </div>

            <Reveal
              visible={revealed[3]}
              delay={360}
              className="flex flex-wrap items-center justify-between gap-3 border-t border-border/70 pt-3 sm:pt-4"
            >
              <div className="flex items-center gap-4">
                <button
                  type="button"
                  onClick={() => scrollToSection(0, true)}
                  className="inline-flex items-center gap-1.5 font-mono text-[10px] font-medium tracking-[0.16em] text-foreground uppercase transition-opacity hover:opacity-75"
                >
                  <span>Index a Repository</span>
                  <ArrowUp className="size-3" />
                </button>
                <Link
                  href="/dashboard"
                  className="inline-flex items-center gap-1 font-mono text-[10px] tracking-[0.16em] text-muted-foreground uppercase transition-colors hover:text-foreground"
                >
                  <span>Open Console</span>
                  <ArrowUpRight className="size-3" />
                </Link>
              </div>
              <button
                type="button"
                onClick={() => scrollToSection(4)}
                className="inline-flex items-center gap-1.5 font-mono text-[10px] tracking-[0.16em] text-muted-foreground uppercase transition-colors hover:text-foreground"
              >
                <span>Signature</span>
                <ArrowDown className="size-3" />
              </button>
            </Reveal>
          </div>
        </section>

        {/* =====================================================================
            SECTION 05 — CLOSING / SIGNATURE
           ===================================================================== */}
        <section
          id="signature"
          data-section-index={4}
          ref={(el) => {
            sectionRefs.current[4] = el;
          }}
          className="relative flex h-[100dvh] w-full snap-start snap-always flex-col overflow-hidden border-t border-border/60 pt-14"
        >
          <div className="pointer-events-none absolute inset-0 overflow-hidden select-none">
            <img
              src="/images/earth-dark.jpg"
              alt=""
              aria-hidden="true"
              className="h-full w-full object-cover object-center opacity-[0.06] contrast-125 dark:opacity-[0.10] [mask-image:radial-gradient(ellipse_60%_60%_at_50%_55%,black_15%,transparent_100%)]"
            />
          </div>

          <div className="relative z-10 mx-auto flex w-full max-w-6xl flex-1 flex-col justify-between px-4 py-8 sm:px-6 sm:py-12">
            <div />

            <div className="mx-auto flex max-w-xl flex-col items-center space-y-6 text-center">
              <Reveal visible={revealed[4]} className="space-y-2">
                <p className="font-mono text-[10px] tracking-[0.24em] text-muted-foreground uppercase">
                  04 // END OF TELEMETRY
                </p>
                <div className="mx-auto h-px w-10 bg-border" />
              </Reveal>

              <div className="font-mono text-sm tracking-[0.08em] text-foreground sm:text-base">
                <SignatureTypewriter
                  text="Created by Aalok Shrivastav"
                  active={revealed[4]}
                  reducedMotion={reducedMotion}
                />
              </div>

              <Reveal
                visible={revealed[4]}
                delay={360}
                className="flex flex-wrap items-center justify-center gap-6 pt-1 font-mono text-[11px] tracking-[0.14em] text-muted-foreground uppercase"
              >
                <a
                  href="https://github.com/Alok9888"
                  target="_blank"
                  rel="noreferrer"
                  className="group inline-flex items-center gap-1.5 transition-colors hover:text-foreground"
                >
                  <span>GitHub</span>
                  <ArrowUpRight className="size-3 opacity-60 transition-transform duration-200 group-hover:translate-x-0.5 group-hover:-translate-y-0.5 group-hover:opacity-100" />
                </a>
                <span className="h-3 w-px bg-border" aria-hidden="true" />
                <a
                  href="mailto:alokshri571@gmail.com"
                  className="group inline-flex items-center gap-1.5 transition-colors hover:text-foreground"
                >
                  <Mail className="size-3 opacity-60 transition-opacity group-hover:opacity-100" />
                  <span className="normal-case tracking-[0.04em]">alokshri571@gmail.com</span>
                </a>
              </Reveal>
            </div>

            <footer className="flex flex-wrap items-center justify-between gap-3 border-t border-border/60 pt-4 font-mono text-[10px] tracking-[0.16em] text-muted-foreground/75 uppercase">
              <span>TRACE // CODEBASE MISSION CONTROL</span>
              <button
                type="button"
                onClick={() => scrollToSection(0)}
                className="inline-flex items-center gap-1.5 text-muted-foreground transition-colors hover:text-foreground"
              >
                <span>Back to Top</span>
                <ArrowUp className="size-3" />
              </button>
            </footer>
          </div>
        </section>
      </div>
    </div>
  );
}
