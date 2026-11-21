"use client";

import Link from "next/link";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { useRouter } from "next/navigation";
import { ArrowDown, ArrowRight, ArrowUp, ArrowUpRight, Mail } from "lucide-react";

import { BrandMark } from "@/components/layout/app-shell";
import {
  AnimatedNumber,
  Reveal,
  SignatureTypewriter,
  SpotlightCard,
  usePrefersReducedMotion,
} from "@/components/landing/scroll-reveal";
import {
  PIPELINE_BEATS,
  PipelineScrollytelling,
} from "@/components/landing/pipeline-scrollytelling";
import { ModeToggle } from "@/components/ui/mode-toggle";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api";

const CHAPTERS = [
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

const LATENCY_PILLARS = [
  {
    code: "RT-01",
    label: "4-TIER QUERY ROUTING",
    body: "Trivial turns skip RAG (0 ms). Direct lookups hit llama-3.1-8b-instant in 1–3 sentences; architectural traces scale context to llama-3.3-70b-versatile.",
  },
  {
    code: "RT-02",
    label: "ZERO-BLOCKING SSE PATH",
    body: "Streams open immediately with 4 s heartbeats. ChatContextCache validates sessions in 0 ms while messages persist off-path via batched JDBC.",
  },
  {
    code: "RT-03",
    label: "5-MODEL CIRCUIT BREAKER",
    body: "Per-model cooldowns (429 → 5 m, 503 → 60 s) step across four Groq models down to Gemini 2.5 Flash without retrying degraded endpoints.",
  },
] as const;

const BENCHMARKS = [
  { label: "Embedding Calls (1,934 chunks)", before: "108", from: 108, to: 31, suffix: " (3.5×)", barPct: "29%" },
  { label: "Unchanged File Re-Embeds", before: "100%", from: 100, to: 0, suffix: "%", barPct: "4%" },
  { label: "Pre-RAG Session Lookup", before: "Sync DB", from: 85, to: 0, suffix: " ms", barPct: "4%" },
  { label: "Client Stream Frame Cap", before: "Per token", from: 0, to: 60, suffix: " fps rAF", barPct: "100%" },
  { label: "JVM Heap Envelope", before: "Unbounded", from: 512, to: 160, suffix: " MB", barPct: "32%" },
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
    showKnobPreview: true,
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

  // Active chapter (0..4) + active pipeline scrollytelling beat (0..3)
  const [activeChapter, setActiveChapter] = useState(0);
  const [activeBeat, setActiveBeat] = useState(0);
  const [revealed, setRevealed] = useState<boolean[]>([true, true, false, false, false]);

  const hasClickedRef = useRef(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const scrollRootRef = useRef<HTMLDivElement>(null);
  const heroStageRef = useRef<HTMLElement>(null);
  const progressBarRef = useRef<HTMLDivElement>(null);
  const spineProgressRef = useRef<HTMLDivElement>(null);
  const heroBgRef = useRef<HTMLImageElement>(null);
  const orbitalBgRef = useRef<HTMLImageElement>(null);
  const earthBgRef = useRef<HTMLImageElement>(null);

  const chapterStopsRef = useRef<(HTMLElement | null)[]>([null, null, null, null, null]);
  const beatStopsRef = useRef<(HTMLDivElement | null)[]>([null, null, null, null]);

  const reducedMotion = usePrefersReducedMotion();
  const router = useRouter();

  // Wake a sleeping Render backend while the user is exploring or pasting a GitHub URL
  useEffect(() => {
    void fetch("/backend/api/health", { cache: "no-store" }).catch(() => {});
  }, []);

  // Continuous 60fps scroll-driven telemetry: progress rail, parallax depth, and scrollytelling beats
  useEffect(() => {
    const root = scrollRootRef.current;
    if (!root) return;

    let rafId = 0;

    const syncScroll = () => {
      rafId = 0;
      const vh = root.clientHeight || window.innerHeight || 1;
      const scrollTop = root.scrollTop;
      const maxScroll = Math.max(1, root.scrollHeight - vh);
      const globalProgress = Math.min(1, Math.max(0, scrollTop / maxScroll));

      // 1px top telemetry progress bar (0 React re-renders)
      if (progressBarRef.current) {
        progressBarRef.current.style.transform = `scaleX(${globalProgress})`;
      }

      // Continuous scrollytelling spine progress across the 400dvh track (scrollTop 1vh..4vh)
      const beatFloat = (scrollTop - vh) / vh;
      const clampedBeatProgress = Math.min(1, Math.max(0, beatFloat / (PIPELINE_BEATS.length - 1)));
      if (spineProgressRef.current) {
        spineProgressRef.current.style.transform = `scaleY(${0.15 + clampedBeatProgress * 0.85})`;
      }

      // Determine active beat (0..3) and active chapter (0..4)
      const nextBeat = Math.min(
        PIPELINE_BEATS.length - 1,
        Math.max(0, Math.round(beatFloat))
      );
      setActiveBeat((prev) => (prev === nextBeat ? prev : nextBeat));

      let nextChapter = 0;
      if (scrollTop < vh * 0.55) {
        nextChapter = 0;
      } else if (scrollTop < vh * 4.55) {
        nextChapter = 1;
      } else if (scrollTop < vh * 5.55) {
        nextChapter = 2;
      } else if (scrollTop < vh * 6.55) {
        nextChapter = 3;
      } else {
        nextChapter = 4;
      }

      setActiveChapter((prev) => (prev === nextChapter ? prev : nextChapter));
      setRevealed((prev) => {
        if (prev[nextChapter]) return prev;
        const copy = [...prev];
        copy[nextChapter] = true;
        return copy;
      });

      // Subtle GPU-composited parallax on real monochrome photography
      if (!reducedMotion) {
        if (heroBgRef.current) {
          const heroDelta = Math.min(1.2, Math.max(-0.5, scrollTop / vh));
          heroBgRef.current.style.transform = `translate3d(0, ${heroDelta * -46}px, 0) scale(${1.03 + heroDelta * 0.05})`;
        }
        if (orbitalBgRef.current) {
          const orbDelta = Math.min(1, Math.max(0, clampedBeatProgress));
          orbitalBgRef.current.style.transform = `translate3d(0, ${(orbDelta - 0.5) * -36}px, 0) scale(${1.05 + orbDelta * 0.06})`;
        }
        if (earthBgRef.current) {
          const sigDelta = (scrollTop - vh * 7) / vh;
          earthBgRef.current.style.transform = `translate3d(0, ${sigDelta * -32}px, 0) scale(${1.04 + Math.abs(sigDelta) * 0.04})`;
        }
      }
    };

    const onScroll = () => {
      if (rafId === 0) {
        rafId = requestAnimationFrame(syncScroll);
      }
    };

    syncScroll();
    root.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll, { passive: true });
    return () => {
      root.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
      if (rafId) cancelAnimationFrame(rafId);
    };
  }, [reducedMotion]);

  const scrollToChapter = useCallback(
    (chapterIndex: number, focusInput = false) => {
      const target =
        chapterIndex === 1
          ? beatStopsRef.current[0]
          : chapterStopsRef.current[chapterIndex];
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

  const scrollToBeat = useCallback(
    (beatIndex: number) => {
      const target = beatStopsRef.current[beatIndex];
      if (!target) return;
      target.scrollIntoView({
        behavior: reducedMotion ? "auto" : "smooth",
        block: "start",
      });
    },
    [reducedMotion]
  );

  const registerBeatStop = useCallback((beatIndex: number, el: HTMLDivElement | null) => {
    beatStopsRef.current[beatIndex] = el;
  }, []);

  function handleHeroPointerMove(e: ReactPointerEvent<HTMLElement>) {
    if (reducedMotion || !heroStageRef.current) return;
    const rect = heroStageRef.current.getBoundingClientRect();
    heroStageRef.current.style.setProperty("--hero-mx", `${e.clientX - rect.left}px`);
    heroStageRef.current.style.setProperty("--hero-my", `${e.clientY - rect.top}px`);
  }

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
      {/* Fixed top mission bar + razor-thin live scroll progress beam */}
      <header className="fixed inset-x-0 top-0 z-40 h-14 border-b border-border/80 bg-background/75 backdrop-blur-md">
        <div className="mx-auto flex h-full w-full max-w-6xl items-center justify-between px-4 sm:px-6">
          <button
            type="button"
            onClick={() => scrollToChapter(0)}
            aria-label="Scroll to top"
            className="text-left transition-opacity hover:opacity-80 focus-visible:outline-none"
          >
            <BrandMark />
          </button>

          <div className="flex items-center gap-4 sm:gap-5">
            <span className="tabular-telemetry hidden font-mono text-[10px] tracking-[0.18em] text-muted-foreground uppercase md:inline">
              {CHAPTERS[activeChapter]?.num} / 0{CHAPTERS.length} ·{" "}
              {activeChapter === 1
                ? `PIPELINE ${PIPELINE_BEATS[activeBeat]?.step}/04`
                : CHAPTERS[activeChapter]?.label}
            </span>
            <span className="hidden items-center gap-2 font-mono text-[10px] tracking-[0.18em] text-muted-foreground uppercase sm:inline-flex">
              <span className="size-1.5 animate-pulse rounded-full bg-foreground/85" />
              SYS // NOMINAL
            </span>
            <Link
              href="/dashboard"
              className="group relative font-heading text-xs font-semibold tracking-[0.16em] text-muted-foreground uppercase transition-colors hover:text-foreground"
            >
              <span>Console</span>
              <span className="absolute -bottom-1 left-0 h-px w-full origin-left scale-x-0 bg-foreground transition-transform duration-300 group-hover:scale-x-100" />
            </Link>
            <ModeToggle />
          </div>
        </div>
        {/* Continuous 1px scroll telemetry beam */}
        <div className="pointer-events-none absolute inset-x-0 bottom-0 h-px bg-transparent">
          <div
            ref={progressBarRef}
            className="h-full w-full origin-left bg-foreground/75 will-change-transform"
            style={{ transform: "scaleX(0)" }}
          />
        </div>
      </header>

      {/* Whisper-quiet right-edge navigation rail (desktop) */}
      <nav
        aria-label="Page sections"
        className="fixed top-1/2 right-5 z-30 hidden -translate-y-1/2 flex-col items-end gap-3 lg:flex"
      >
        {CHAPTERS.map((ch, idx) => {
          const isActive = activeChapter === idx;
          return (
            <button
              key={ch.id}
              type="button"
              onClick={() => scrollToChapter(idx)}
              aria-label={`Jump to ${ch.label}`}
              aria-current={isActive ? "true" : undefined}
              className="group flex items-center gap-2 py-1"
            >
              <span
                className={`font-mono text-[9px] tracking-[0.18em] uppercase transition-all duration-200 ${
                  isActive
                    ? "translate-x-0 text-foreground opacity-100"
                    : "translate-x-1 text-muted-foreground opacity-0 group-hover:translate-x-0 group-hover:opacity-80"
                }`}
              >
                {ch.num}
              </span>
              <span
                className={`block h-px transition-all duration-300 ${
                  isActive
                    ? "w-7 bg-foreground"
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
            SECTION 01 — HERO (100dvh)
           ===================================================================== */}
        <section
          id="hero"
          ref={(el) => {
            heroStageRef.current = el;
            chapterStopsRef.current[0] = el;
          }}
          onPointerMove={handleHeroPointerMove}
          className="relative flex h-[100dvh] w-full snap-start snap-always flex-col overflow-hidden pt-14"
        >
          {/* Monochrome SpaceX launch backdrop with smooth scroll parallax + cursor light */}
          <div className="pointer-events-none absolute inset-0 overflow-hidden select-none">
            <img
              ref={heroBgRef}
              src="/images/spacex-launch-arc.jpg"
              alt=""
              aria-hidden="true"
              className="h-full w-full scale-[1.03] object-cover object-[72%_35%] opacity-[0.22] contrast-125 will-change-transform sm:object-right-bottom dark:opacity-[0.32] [mask-image:radial-gradient(ellipse_80%_75%_at_75%_55%,black_25%,transparent_100%)]"
            />
            <div className="mission-grid absolute inset-0 opacity-60" />
            <div className="hero-spotlight absolute inset-0 transition-opacity duration-500" />
          </div>

          <main className="relative z-10 mx-auto flex w-full max-w-6xl flex-1 flex-col justify-between px-4 py-6 sm:px-6 sm:py-10 md:py-12">
            <div className="max-w-2xl space-y-4 pt-2 sm:space-y-6 sm:pt-4 md:pt-8">
              <div className="space-y-2.5 sm:space-y-4">
                <p
                  className="hero-mask-reveal font-mono text-[10px] tracking-[0.22em] text-muted-foreground uppercase sm:text-[11px]"
                  style={{ animationDelay: "40ms" }}
                >
                  00 // CODEBASE TELEMETRY ENGINE
                </p>
                <h1
                  className="hero-mask-reveal font-heading text-[2rem] leading-[1.02] font-semibold tracking-[0.04em] uppercase sm:text-5xl lg:text-6xl"
                  style={{ animationDelay: "120ms" }}
                >
                  Interrogate Any Repository.
                </h1>
                <p
                  className="hero-mask-reveal max-w-lg text-xs leading-relaxed text-muted-foreground sm:text-base"
                  style={{ animationDelay: "210ms" }}
                >
                  Stream public GitHub source trees into vector space and query architecture,
                  execution paths, and symbols with line-level citations.
                </p>
              </div>

              {/* Launch command input bar */}
              <div
                className="hero-mask-reveal space-y-2.5 pt-1 sm:space-y-3 sm:pt-2"
                style={{ animationDelay: "300ms" }}
              >
                <div className="group/bar flex flex-col border border-input bg-background/85 backdrop-blur-sm transition-all duration-200 hover:border-foreground/50 focus-within:border-foreground sm:flex-row">
                  <div className="flex min-w-0 flex-1 items-center">
                    <div className="flex shrink-0 items-center border-r border-border/70 px-3 py-2 font-mono text-[11px] tracking-[0.12em] text-muted-foreground uppercase transition-colors group-focus-within/bar:text-foreground sm:px-3.5">
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
                    className={`h-11 rounded-none border-0 border-t border-input bg-transparent px-7 text-foreground transition-all duration-200 hover:bg-foreground hover:text-background sm:h-12 sm:border-t-0 sm:border-l ${
                      isClicked ? "pointer-events-none opacity-60" : ""
                    }`}
                  >
                    Analyze
                    <ArrowRight
                      className={`size-3.5 transition-transform duration-200 ${
                        isClicked ? "translate-x-1" : "group-hover/button:translate-x-1"
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

            {/* Bottom tactile spec strip + kinetic scroll cue */}
            <div className="space-y-4 sm:space-y-6">
              <div className="grid gap-2.5 border-t border-border/80 pt-4 sm:gap-5 sm:pt-5 md:grid-cols-3">
                {HERO_SPECS.map((item) => (
                  <SpotlightCard
                    key={item.index}
                    className="group space-y-1 border border-transparent px-2.5 py-2 sm:space-y-2 sm:px-3 sm:py-2.5"
                  >
                    <div className="flex items-center justify-between gap-2 font-mono text-[10px] tracking-[0.2em] text-muted-foreground sm:text-[11px]">
                      <div className="flex items-center gap-2.5">
                        <span className="transition-colors group-hover:text-foreground">
                          {item.index}
                        </span>
                        <span className="h-px w-5 bg-border transition-all duration-300 group-hover:w-7 group-hover:bg-foreground/70" />
                        <span className="font-heading text-xs font-semibold tracking-[0.18em] text-foreground">
                          {item.title}
                        </span>
                      </div>
                      <span className="tabular-telemetry text-[9px] tracking-[0.12em] text-muted-foreground/75 uppercase transition-colors group-hover:text-foreground/90 sm:text-[10px]">
                        {item.metric}
                      </span>
                    </div>
                    <p className="text-[11px] leading-relaxed text-muted-foreground sm:text-xs">
                      {item.body}
                    </p>
                  </SpotlightCard>
                ))}
              </div>

              <div className="flex items-center justify-between">
                <button
                  type="button"
                  onClick={() => scrollToChapter(1)}
                  className="group inline-flex items-center gap-2 font-mono text-[10px] tracking-[0.2em] text-muted-foreground uppercase transition-colors hover:text-foreground"
                >
                  <span>Unfold Pipeline</span>
                  <ArrowDown className="scroll-cue-pulse size-3" />
                </button>
                <span className="hidden font-mono text-[10px] tracking-[0.16em] text-muted-foreground/60 uppercase sm:inline">
                  SCROLL TO EXPLORE
                </span>
              </div>
            </div>
          </main>
        </section>

        {/* =====================================================================
            SECTION 02 — SCROLLYTELLING CHAPTER: THE PIPELINE (4 pinned 100dvh beats)
           ===================================================================== */}
        <PipelineScrollytelling
          activeBeat={activeBeat}
          spineProgressRef={spineProgressRef}
          orbitalBgRef={orbitalBgRef}
          registerBeatStop={registerBeatStop}
          onSelectBeat={scrollToBeat}
          onNextSection={() => scrollToChapter(2)}
        />

        {/* =====================================================================
            SECTION 03 — UNDER THE HOOD II: RUNTIME & BENCHMARKS (100dvh)
           ===================================================================== */}
        <section
          id="latency"
          ref={(el) => {
            chapterStopsRef.current[2] = el;
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

            <div className="grid items-start gap-4 lg:grid-cols-12 lg:gap-8">
              {/* Left: Interactive hover runtime pillars */}
              <div className="space-y-2.5 sm:space-y-3.5 lg:col-span-6">
                {LATENCY_PILLARS.map((item, i) => (
                  <Reveal key={item.label} visible={revealed[2]} delay={80 + i * 75}>
                    <SpotlightCard className="group border border-border/75 bg-card/55 px-3.5 py-3 sm:px-4 sm:py-3.5">
                      <div className="flex items-center justify-between gap-2 font-mono text-[10px] tracking-[0.16em] uppercase sm:text-[11px]">
                        <span className="font-medium text-foreground">{item.label}</span>
                        <span className="text-[9px] text-muted-foreground/70 transition-colors group-hover:text-foreground">
                          {item.code}
                        </span>
                      </div>
                      <p className="mt-1.5 text-[11px] leading-relaxed text-muted-foreground sm:text-xs">
                        {item.body}
                      </p>
                    </SpotlightCard>
                  </Reveal>
                ))}
              </div>

              {/* Right: Animated Count-Up & Metric Bars Ledger */}
              <Reveal visible={revealed[2]} delay={200} className="lg:col-span-6">
                <SpotlightCard className="border border-border/80 bg-card/70">
                  <div className="grid grid-cols-[1.4fr_0.65fr_0.95fr] border-b border-border/80 px-3.5 py-2 font-mono text-[9px] tracking-[0.18em] text-muted-foreground uppercase sm:px-4 sm:py-2.5 sm:text-[10px]">
                    <span>Metric</span>
                    <span>Before</span>
                    <span className="text-right text-foreground">After</span>
                  </div>
                  <div className="divide-y divide-border/60">
                    {BENCHMARKS.map((row, idx) => (
                      <div
                        key={row.label}
                        className="group space-y-1.5 px-3.5 py-2 transition-colors hover:bg-foreground/[0.03] sm:px-4 sm:py-2.5"
                      >
                        <div className="grid grid-cols-[1.4fr_0.65fr_0.95fr] items-center gap-2 font-mono text-[10px] sm:text-xs">
                          <span className="truncate text-muted-foreground transition-colors group-hover:text-foreground">
                            {row.label}
                          </span>
                          <span className="tabular-telemetry text-muted-foreground/60 line-through decoration-border">
                            {row.before}
                          </span>
                          <span className="text-right font-medium text-foreground transition-transform duration-200 group-hover:-translate-x-0.5">
                            <AnimatedNumber
                              from={row.from}
                              to={row.to}
                              suffix={row.suffix}
                              active={revealed[2]}
                              reducedMotion={reducedMotion}
                            />
                          </span>
                        </div>
                        <div className="h-[2px] w-full bg-border/50">
                          <div
                            data-visible={revealed[2] ? "true" : "false"}
                            style={{
                              width: row.barPct,
                              transitionDelay: `${260 + idx * 80}ms`,
                            }}
                            className="metric-bar-fill h-full bg-foreground/75"
                          />
                        </div>
                      </div>
                    ))}
                  </div>
                </SpotlightCard>
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
                onClick={() => scrollToChapter(3)}
                className="group inline-flex items-center gap-1.5 text-foreground/80 transition-colors hover:text-foreground"
              >
                <span>The Edge</span>
                <ArrowDown className="size-3 transition-transform duration-200 group-hover:translate-y-0.5" />
              </button>
            </Reveal>
          </div>
        </section>

        {/* =====================================================================
            SECTION 04 — THE EDGE (100dvh)
           ===================================================================== */}
        <section
          id="edge"
          ref={(el) => {
            chapterStopsRef.current[3] = el;
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
                <Reveal key={point.num} visible={revealed[3]} delay={80 + i * 75}>
                  <SpotlightCard className="group flex h-full flex-col justify-between border border-border/80 bg-card/60 p-3.5 sm:p-5">
                    <div>
                      <div className="flex items-center justify-between gap-2 font-mono text-[10px] tracking-[0.16em] text-muted-foreground uppercase">
                        <span className="transition-colors group-hover:text-foreground">
                          {point.num}
                        </span>
                        <span className="border border-border/80 px-2 py-0.5 text-[9px] text-foreground/75 transition-colors duration-200 group-hover:border-foreground group-hover:bg-foreground group-hover:text-background">
                          {point.tag}
                        </span>
                      </div>
                      <h3 className="mt-2 font-heading text-xs font-semibold tracking-[0.1em] text-foreground uppercase sm:text-sm">
                        {point.title}
                      </h3>
                      <p className="mt-1.5 text-[11px] leading-relaxed text-muted-foreground sm:text-xs">
                        {point.body}
                      </p>
                    </div>

                    {"showKnobPreview" in point && point.showKnobPreview && (
                      <div className="mt-3 hidden items-center gap-3 border-t border-border/60 pt-2.5 font-mono text-[9px] tracking-[0.12em] text-muted-foreground uppercase sm:flex">
                        <span>TEMP 0.20</span>
                        <div className="relative h-px flex-1 bg-border">
                          <span className="absolute top-1/2 left-[20%] size-2 -translate-y-1/2 bg-foreground transition-all duration-500 ease-out group-hover:left-[68%]" />
                        </div>
                        <span>TOP-K 5</span>
                        <div className="relative h-px flex-1 bg-border">
                          <span className="absolute top-1/2 left-[50%] size-2 -translate-y-1/2 bg-foreground transition-all duration-500 ease-out group-hover:left-[80%]" />
                        </div>
                      </div>
                    )}
                  </SpotlightCard>
                </Reveal>
              ))}
            </div>

            <Reveal
              visible={revealed[3]}
              delay={360}
              className="flex flex-wrap items-center justify-between gap-3 border-t border-border/70 pt-3 sm:pt-4"
            >
              <div className="flex items-center gap-5">
                <button
                  type="button"
                  onClick={() => scrollToChapter(0, true)}
                  className="group relative inline-flex items-center gap-1.5 font-mono text-[10px] font-medium tracking-[0.16em] text-foreground uppercase"
                >
                  <span>Index a Repository</span>
                  <ArrowUp className="size-3 transition-transform duration-200 group-hover:-translate-y-0.5" />
                  <span className="absolute -bottom-1 left-0 h-px w-full origin-left scale-x-0 bg-foreground transition-transform duration-300 group-hover:scale-x-100" />
                </button>
                <Link
                  href="/dashboard"
                  className="group relative inline-flex items-center gap-1 font-mono text-[10px] tracking-[0.16em] text-muted-foreground uppercase transition-colors hover:text-foreground"
                >
                  <span>Open Console</span>
                  <ArrowUpRight className="size-3 transition-transform duration-200 group-hover:translate-x-0.5 group-hover:-translate-y-0.5" />
                  <span className="absolute -bottom-1 left-0 h-px w-full origin-left scale-x-0 bg-foreground transition-transform duration-300 group-hover:scale-x-100" />
                </Link>
              </div>
              <button
                type="button"
                onClick={() => scrollToChapter(4)}
                className="group inline-flex items-center gap-1.5 font-mono text-[10px] tracking-[0.16em] text-muted-foreground uppercase transition-colors hover:text-foreground"
              >
                <span>Signature</span>
                <ArrowDown className="size-3 transition-transform duration-200 group-hover:translate-y-0.5" />
              </button>
            </Reveal>
          </div>
        </section>

        {/* =====================================================================
            SECTION 05 — CLOSING / SIGNATURE (100dvh)
           ===================================================================== */}
        <section
          id="signature"
          ref={(el) => {
            chapterStopsRef.current[4] = el;
          }}
          className="relative flex h-[100dvh] w-full snap-start snap-always flex-col overflow-hidden border-t border-border/60 pt-14"
        >
          <div className="pointer-events-none absolute inset-0 overflow-hidden select-none">
            <img
              ref={earthBgRef}
              src="/images/earth-dark.jpg"
              alt=""
              aria-hidden="true"
              className="h-full w-full scale-105 object-cover object-center opacity-[0.06] contrast-125 will-change-transform dark:opacity-[0.11] [mask-image:radial-gradient(ellipse_60%_60%_at_50%_55%,black_15%,transparent_100%)]"
            />
            {/* Whisper-quiet slow rotating orbital hairline ring */}
            <svg
              aria-hidden="true"
              viewBox="0 0 600 600"
              className="orbital-spin absolute top-1/2 left-1/2 size-[440px] -translate-x-1/2 -translate-y-1/2 opacity-[0.14] sm:size-[560px]"
            >
              <circle
                cx="300"
                cy="300"
                r="260"
                fill="none"
                stroke="currentColor"
                strokeWidth="0.75"
                strokeDasharray="3 10"
              />
              <circle
                cx="300"
                cy="300"
                r="195"
                fill="none"
                stroke="currentColor"
                strokeWidth="0.5"
                strokeOpacity="0.55"
              />
            </svg>
          </div>

          <div className="relative z-10 mx-auto flex w-full max-w-6xl flex-1 flex-col justify-between px-4 py-8 sm:px-6 sm:py-12">
            <div />

            <div className="mx-auto flex max-w-xl flex-col items-center space-y-6 text-center">
              <Reveal visible={revealed[4]} className="space-y-2.5">
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
                  className="group relative inline-flex items-center gap-1.5 py-0.5 transition-colors hover:text-foreground"
                >
                  <span>GitHub</span>
                  <ArrowUpRight className="size-3 opacity-60 transition-transform duration-200 group-hover:translate-x-0.5 group-hover:-translate-y-0.5 group-hover:opacity-100" />
                  <span className="absolute bottom-0 left-0 h-px w-full origin-left scale-x-0 bg-foreground transition-transform duration-300 group-hover:scale-x-100" />
                </a>
                <span className="h-3 w-px bg-border" aria-hidden="true" />
                <a
                  href="mailto:alokshri571@gmail.com"
                  className="group relative inline-flex items-center gap-1.5 py-0.5 transition-colors hover:text-foreground"
                >
                  <Mail className="size-3 opacity-60 transition-opacity group-hover:opacity-100" />
                  <span className="normal-case tracking-[0.04em]">alokshri571@gmail.com</span>
                  <span className="absolute bottom-0 left-0 h-px w-full origin-left scale-x-0 bg-foreground transition-transform duration-300 group-hover:scale-x-100" />
                </a>
              </Reveal>
            </div>

            <footer className="flex flex-wrap items-center justify-between gap-3 border-t border-border/60 pt-4 font-mono text-[10px] tracking-[0.16em] text-muted-foreground/75 uppercase">
              <span>TRACE // CODEBASE MISSION CONTROL</span>
              <button
                type="button"
                onClick={() => scrollToChapter(0)}
                className="group inline-flex items-center gap-1.5 text-muted-foreground transition-colors hover:text-foreground"
              >
                <span>Back to Top</span>
                <ArrowUp className="size-3 transition-transform duration-200 group-hover:-translate-y-0.5" />
              </button>
            </footer>
          </div>
        </section>
      </div>
    </div>
  );
}
