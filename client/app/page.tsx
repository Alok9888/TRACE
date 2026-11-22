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
import {
  ArrowDown,
  ArrowRight,
  ArrowUp,
  ArrowUpRight,
  ChevronDown,
  Mail,
} from "lucide-react";

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
  { id: "latency", num: "03", label: "Benchmarks" },
  { id: "edge", num: "04", label: "Edge" },
  { id: "signature", num: "05", label: "Author" },
] as const;

const SAMPLE_REPOS = [
  { label: "sindresorhus/ow", url: "https://github.com/sindresorhus/ow" },
  { label: "colinhacks/zod", url: "https://github.com/colinhacks/zod" },
  { label: "expressjs/express", url: "https://github.com/expressjs/express" },
] as const;

const BENCHMARK_CARDS = [
  {
    code: "01",
    label: "Embed Calls",
    before: "108",
    from: 108,
    to: 31,
    suffix: "",
    note: "3.5× fewer per repo",
    barPct: "29%",
  },
  {
    code: "02",
    label: "Re-Embed Waste",
    before: "100%",
    from: 100,
    to: 0,
    suffix: "%",
    note: "Unchanged files skipped",
    barPct: "4%",
  },
  {
    code: "03",
    label: "Session Lookup",
    before: "Sync DB",
    from: 85,
    to: 0,
    suffix: " ms",
    note: "In-memory cache hit",
    barPct: "4%",
  },
  {
    code: "04",
    label: "JVM Heap",
    before: "512 MB",
    from: 512,
    to: 160,
    suffix: " MB",
    note: "60 fps streamed UI",
    barPct: "32%",
  },
] as const;

const EDGE_ROWS = [
  {
    num: "01",
    title: "Zero Auth",
    summary: "Paste any public repo. Instant access.",
    tag: "NO OAUTH",
  },
  {
    num: "02",
    title: "5 Live Knobs",
    summary: "Temperature, tokens, Top-K, threshold, prompt.",
    tag: "EXPOSED RAG",
    showKnobPreview: true,
  },
  {
    num: "03",
    title: "Line Citations",
    summary: "Every answer links directly to file and line.",
    tag: "VERIFIABLE",
  },
  {
    num: "04",
    title: "Adaptive Depth",
    summary: "Short lookups stay short. Traces go deep.",
    tag: "4-TIER",
  },
] as const;

export default function HomePage() {
  const [repoUrl, setRepoUrl] = useState("");
  const [error, setError] = useState("");
  const [isClicked, setIsClicked] = useState(false);

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
  const ascentBgRef = useRef<HTMLImageElement>(null);
  const edgeBgRef = useRef<HTMLImageElement>(null);
  const earthBgRef = useRef<HTMLImageElement>(null);

  const chapterStopsRef = useRef<(HTMLElement | null)[]>([null, null, null, null, null]);
  const beatStopsRef = useRef<(HTMLDivElement | null)[]>([null, null, null]);

  const reducedMotion = usePrefersReducedMotion();
  const router = useRouter();

  // Wake a sleeping Render backend while the user is exploring or pasting a GitHub URL
  useEffect(() => {
    void fetch("/backend/api/health", { cache: "no-store" }).catch(() => {});
  }, []);

  // Continuous 60fps scroll-driven telemetry: progress rail, parallax depth, and 3-beat scrollytelling
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

      if (progressBarRef.current) {
        progressBarRef.current.style.transform = `scaleX(${globalProgress})`;
      }

      // Pipeline track spans 1vh..3vh (3 beats: 0, 1, 2)
      const beatCount = PIPELINE_BEATS.length;
      const beatFloat = (scrollTop - vh) / vh;
      const clampedBeatProgress = Math.min(1, Math.max(0, beatFloat / (beatCount - 1)));
      if (spineProgressRef.current) {
        spineProgressRef.current.style.transform = `scaleY(${0.2 + clampedBeatProgress * 0.8})`;
      }

      const nextBeat = Math.min(beatCount - 1, Math.max(0, Math.round(beatFloat)));
      setActiveBeat((prev) => (prev === nextBeat ? prev : nextBeat));

      let nextChapter = 0;
      if (scrollTop < vh * 0.55) {
        nextChapter = 0;
      } else if (scrollTop < vh * (beatCount + 0.55)) {
        nextChapter = 1;
      } else if (scrollTop < vh * (beatCount + 1.55)) {
        nextChapter = 2;
      } else if (scrollTop < vh * (beatCount + 2.55)) {
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

      if (!reducedMotion) {
        if (heroBgRef.current) {
          const heroDelta = Math.min(1.2, Math.max(-0.5, scrollTop / vh));
          heroBgRef.current.style.transform = `translate3d(0, ${heroDelta * -46}px, 0) scale(${1.03 + heroDelta * 0.05})`;
        }
        if (orbitalBgRef.current) {
          const orbDelta = Math.min(1, Math.max(0, clampedBeatProgress));
          orbitalBgRef.current.style.transform = `translate3d(0, ${(orbDelta - 0.5) * -36}px, 0) scale(${1.05 + orbDelta * 0.06})`;
        }
        if (ascentBgRef.current) {
          const benchOffset = (scrollTop - vh * (beatCount + 1)) / vh;
          ascentBgRef.current.style.transform = `translate3d(0, ${benchOffset * -42}px, 0) scale(${1.05 + Math.abs(benchOffset) * 0.05})`;
        }
        if (edgeBgRef.current) {
          const edgeOffset = (scrollTop - vh * (beatCount + 2)) / vh;
          edgeBgRef.current.style.transform = `translate3d(0, ${edgeOffset * -38}px, 0) scale(${1.05 + Math.abs(edgeOffset) * 0.05})`;
        }
        if (earthBgRef.current) {
          const sigOffset = (scrollTop - vh * (beatCount + 3)) / vh;
          earthBgRef.current.style.transform = `translate3d(0, ${sigOffset * -32}px, 0) scale(${1.04 + Math.abs(sigOffset) * 0.04})`;
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

  function launchUrl(rawUrl: string) {
    if (hasClickedRef.current) return;

    if (!rawUrl.trim()) {
      inputRef.current?.focus();
      setError("Enter a valid GitHub repository URL");
      return;
    }

    const match = rawUrl.trim().match(/github\.com\/([^/]+)\/([^/?#]+)/i);
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
      {/* Minimal fixed navbar + 1px scroll progress beam */}
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
                ? PIPELINE_BEATS[activeBeat]?.shortLabel
                : CHAPTERS[activeChapter]?.label}
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
        <div className="pointer-events-none absolute inset-x-0 bottom-0 h-px bg-transparent">
          <div
            ref={progressBarRef}
            className="h-full w-full origin-left bg-foreground/75 will-change-transform"
            style={{ transform: "scaleX(0)" }}
          />
        </div>
      </header>

      {/* Right-edge chapter rail (desktop) */}
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
            SECTION 01 — HERO (100dvh, zero clutter, mobile-first 1-tap try)
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
          <div className="pointer-events-none absolute inset-0 overflow-hidden select-none">
            <img
              ref={heroBgRef}
              src="/images/spacex-launch-arc.jpg"
              alt=""
              aria-hidden="true"
              className="h-full w-full scale-[1.03] object-cover object-[72%_35%] opacity-[0.22] contrast-125 will-change-transform sm:object-right-bottom dark:opacity-[0.32] [mask-image:radial-gradient(ellipse_80%_75%_at_75%_55%,black_25%,transparent_100%)]"
            />
            <div className="mission-grid absolute inset-0 opacity-55" />
            <div className="hero-spotlight absolute inset-0 transition-opacity duration-500" />
          </div>

          <main className="relative z-10 mx-auto flex w-full max-w-6xl flex-1 flex-col justify-between px-4 py-6 sm:px-6 sm:py-10">
            <div />

            {/* Clean centered/editorial focal stack */}
            <div className="max-w-2xl space-y-6 sm:space-y-8">
              <div className="space-y-3 sm:space-y-4">
                <h1
                  className="hero-mask-reveal font-heading text-[2.4rem] leading-[0.98] font-semibold tracking-[0.04em] uppercase sm:text-6xl lg:text-[4.5rem]"
                  style={{ animationDelay: "60ms" }}
                >
                  Interrogate Any Repository.
                </h1>
                <p
                  className="hero-mask-reveal max-w-md text-sm leading-relaxed text-muted-foreground sm:text-lg"
                  style={{ animationDelay: "150ms" }}
                >
                  Paste a GitHub URL. Get line-cited answers in seconds.
                </p>
              </div>

              <div
                className="hero-mask-reveal space-y-3"
                style={{ animationDelay: "230ms" }}
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
                        if (event.key === "Enter") launchUrl(repoUrl);
                      }}
                      placeholder="https://github.com/owner/repository"
                      aria-label="GitHub repository URL"
                      className="h-12 min-w-0 flex-1 bg-transparent px-3 font-mono text-xs tracking-wide text-foreground outline-none placeholder:text-muted-foreground/60 sm:px-4 sm:text-sm"
                    />
                  </div>
                  <Button
                    variant="outline"
                    size="lg"
                    onClick={() => launchUrl(repoUrl)}
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
                  /* 1-tap sample repos — huge UX win on mobile where typing URLs is slow */
                  <div className="flex flex-wrap items-center gap-2 pt-0.5">
                    <span className="font-mono text-[10px] tracking-[0.14em] text-muted-foreground/75 uppercase">
                      Try:
                    </span>
                    {SAMPLE_REPOS.map((sample) => (
                      <button
                        key={sample.label}
                        type="button"
                        onClick={() => {
                          setRepoUrl(sample.url);
                          setError("");
                          inputRef.current?.focus();
                        }}
                        className="rounded-[2px] border border-border/80 bg-background/60 px-2.5 py-1 font-mono text-[10px] tracking-[0.04em] text-muted-foreground transition-colors hover:border-foreground hover:text-foreground"
                      >
                        {sample.label}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </div>

            {/* Eager, attention-grabbing scroll-down indicator */}
            <div className="flex justify-center pt-4">
              <button
                type="button"
                onClick={() => scrollToChapter(1)}
                className="group inline-flex items-center gap-3.5 rounded-[2px] border border-foreground/35 bg-background/80 px-5 py-2.5 font-mono text-[10px] font-medium tracking-[0.2em] text-foreground uppercase backdrop-blur-md transition-all duration-200 hover:border-foreground hover:bg-foreground hover:text-background"
              >
                <span className="relative h-4 w-px overflow-hidden bg-border group-hover:bg-background/30">
                  <span className="scroll-drop-beam absolute inset-x-0 top-0 h-2 bg-foreground group-hover:bg-background" />
                </span>

                <span>Scroll · See How It Works</span>

                <span className="flex flex-col -space-y-2" aria-hidden="true">
                  <ChevronDown className="scroll-chevron size-3" />
                  <ChevronDown className="scroll-chevron scroll-chevron-2 size-3" />
                  <ChevronDown className="scroll-chevron scroll-chevron-3 size-3" />
                </span>
              </button>
            </div>
          </main>
        </section>

        {/* =====================================================================
            SECTION 02 — SCROLLYTELLING PIPELINE (3 pinned 100dvh beats)
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
            SECTION 03 — BENCHMARKS (100dvh, bold 2x2 spec grid, zero essay)
           ===================================================================== */}
        <section
          id="latency"
          ref={(el) => {
            chapterStopsRef.current[2] = el;
          }}
          className="relative flex h-[100dvh] w-full snap-start snap-always flex-col overflow-hidden border-t border-border/60 pt-14"
        >
          <div className="pointer-events-none absolute inset-0 overflow-hidden select-none">
            <img
              ref={ascentBgRef}
              src="/images/falcon-ascent.jpg"
              alt=""
              aria-hidden="true"
              className="h-full w-full scale-105 object-cover object-center opacity-[0.16] contrast-125 will-change-transform dark:opacity-[0.28] [mask-image:radial-gradient(ellipse_75%_75%_at_55%_50%,black_25%,transparent_100%)]"
            />
            <div className="mission-grid absolute inset-0 opacity-40" />
          </div>

          <div className="relative z-10 mx-auto flex w-full max-w-6xl flex-1 flex-col justify-between px-4 py-6 sm:px-6 sm:py-10 md:py-12">
            <Reveal visible={revealed[2]} className="space-y-1.5">
              <p className="font-mono text-[10px] tracking-[0.22em] text-muted-foreground uppercase">
                02 // BENCHMARKS
              </p>
              <h2 className="font-heading text-2xl leading-[1.04] font-semibold tracking-[0.04em] uppercase sm:text-4xl lg:text-5xl">
                Fast by architecture.
              </h2>
            </Reveal>

            {/* Spacious 2x2 high-contrast telemetry grid — effortless to scan on mobile & desktop */}
            <div className="grid grid-cols-2 gap-3 sm:gap-5">
              {BENCHMARK_CARDS.map((card, idx) => (
                <Reveal key={card.code} visible={revealed[2]} delay={70 + idx * 75}>
                  <SpotlightCard className="group flex h-full flex-col justify-between border border-border/80 bg-card/70 p-4 sm:p-6">
                    <div className="flex items-center justify-between gap-2 font-mono text-[10px] tracking-[0.14em] text-muted-foreground uppercase">
                      <span>{card.label}</span>
                      <span className="tabular-telemetry line-through opacity-55">
                        {card.before}
                      </span>
                    </div>

                    <div className="my-3 sm:my-5">
                      <p className="font-heading text-3xl leading-none font-semibold tracking-[0.02em] text-foreground sm:text-5xl lg:text-6xl">
                        <AnimatedNumber
                          from={card.from}
                          to={card.to}
                          suffix={card.suffix}
                          active={revealed[2]}
                          reducedMotion={reducedMotion}
                        />
                      </p>
                      <p className="mt-2 font-mono text-[10px] tracking-[0.1em] text-muted-foreground uppercase sm:text-[11px]">
                        {card.note}
                      </p>
                    </div>

                    <div className="h-[2px] w-full bg-border/50">
                      <div
                        data-visible={revealed[2] ? "true" : "false"}
                        style={{
                          width: card.barPct,
                          transitionDelay: `${220 + idx * 80}ms`,
                        }}
                        className="metric-bar-fill h-full bg-foreground/80"
                      />
                    </div>
                  </SpotlightCard>
                </Reveal>
              ))}
            </div>

            <Reveal
              visible={revealed[2]}
              delay={320}
              className="flex items-center justify-between border-t border-border/70 pt-3 font-mono text-[10px] tracking-[0.16em] text-muted-foreground uppercase"
            >
              <span>4-TIER ROUTING · 5-MODEL FAILOVER</span>
              <button
                type="button"
                onClick={() => scrollToChapter(3)}
                className="group inline-flex items-center gap-1.5 text-foreground/85 transition-colors hover:text-foreground"
              >
                <span>The Edge</span>
                <ArrowDown className="size-3 transition-transform duration-200 group-hover:translate-y-0.5" />
              </button>
            </Reveal>
          </div>
        </section>

        {/* =====================================================================
            SECTION 04 — THE EDGE (100dvh, crisp 4-row hairline spec list)
           ===================================================================== */}
        <section
          id="edge"
          ref={(el) => {
            chapterStopsRef.current[3] = el;
          }}
          className="relative flex h-[100dvh] w-full snap-start snap-always flex-col overflow-hidden border-t border-border/60 pt-14"
        >
          <div className="pointer-events-none absolute inset-0 overflow-hidden select-none">
            <img
              ref={edgeBgRef}
              src="/images/orbital-instrument.jpg"
              alt=""
              aria-hidden="true"
              className="h-full w-full scale-105 object-cover object-[70%_30%] opacity-[0.12] contrast-125 will-change-transform dark:opacity-[0.17] [mask-image:radial-gradient(ellipse_75%_75%_at_75%_45%,black_15%,transparent_100%)]"
            />
            <div className="mission-grid absolute inset-0 opacity-35" />
          </div>

          <div className="relative z-10 mx-auto flex w-full max-w-6xl flex-1 flex-col justify-between px-4 py-6 sm:px-6 sm:py-10 md:py-12">
            <Reveal visible={revealed[3]} className="space-y-1.5">
              <p className="font-mono text-[10px] tracking-[0.22em] text-muted-foreground uppercase">
                03 // WHY TRACE
              </p>
              <h2 className="font-heading text-2xl leading-[1.04] font-semibold tracking-[0.04em] uppercase sm:text-4xl lg:text-5xl">
                No black box.
              </h2>
            </Reveal>

            {/* 4 crisp horizontal tactile rows — scans in 2 seconds, generous mobile breathing room */}
            <div className="divide-y divide-border/70 border-y border-border/80">
              {EDGE_ROWS.map((row, idx) => (
                <Reveal key={row.num} visible={revealed[3]} delay={70 + idx * 65}>
                  <SpotlightCard className="group flex flex-col gap-2 px-3 py-4 sm:flex-row sm:items-center sm:justify-between sm:gap-6 sm:px-5 sm:py-5">
                    <div className="flex items-baseline gap-3 sm:gap-5">
                      <span className="font-mono text-[10px] tracking-[0.18em] text-muted-foreground transition-colors group-hover:text-foreground">
                        {row.num}
                      </span>
                      <div>
                        <h3 className="font-heading text-base font-semibold tracking-[0.06em] text-foreground uppercase sm:text-xl">
                          {row.title}
                        </h3>
                        <p className="mt-0.5 text-xs text-muted-foreground sm:text-sm">
                          {row.summary}
                        </p>
                      </div>
                    </div>

                    <div className="flex items-center justify-between gap-4 pl-7 sm:justify-end sm:pl-0">
                      {"showKnobPreview" in row && row.showKnobPreview && (
                        <div className="hidden w-28 items-center gap-2 font-mono text-[9px] text-muted-foreground md:flex">
                          <div className="relative h-px flex-1 bg-border">
                            <span className="absolute top-1/2 left-[22%] size-2 -translate-y-1/2 bg-foreground transition-all duration-500 ease-out group-hover:left-[76%]" />
                          </div>
                        </div>
                      )}
                      <span className="shrink-0 border border-border/80 px-2.5 py-1 font-mono text-[10px] tracking-[0.14em] text-foreground/80 uppercase transition-colors duration-200 group-hover:border-foreground group-hover:bg-foreground group-hover:text-background">
                        {row.tag}
                      </span>
                    </div>
                  </SpotlightCard>
                </Reveal>
              ))}
            </div>

            <Reveal
              visible={revealed[3]}
              delay={320}
              className="flex flex-wrap items-center justify-between gap-3 pt-2"
            >
              <div className="flex items-center gap-5">
                <button
                  type="button"
                  onClick={() => scrollToChapter(0, true)}
                  className="group relative inline-flex items-center gap-1.5 font-mono text-[10px] font-medium tracking-[0.16em] text-foreground uppercase"
                >
                  <span>Try a Repo</span>
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
                <span>Author</span>
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
              className="h-full w-full scale-105 object-cover object-center opacity-[0.14] contrast-125 will-change-transform dark:opacity-[0.22] [mask-image:radial-gradient(ellipse_68%_65%_at_50%_55%,black_20%,transparent_100%)]"
            />
            <svg
              aria-hidden="true"
              viewBox="0 0 600 600"
              className="orbital-spin absolute top-1/2 left-1/2 size-[360px] -translate-x-1/2 -translate-y-1/2 opacity-[0.14] sm:size-[540px]"
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
                  04 // TRACE
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
