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
  BookOpen,
  Check,
  ChevronDown,
  FileCode2,
  FileText,
  GitBranch,
  KeyRound,
  Layers,
  Mail,
  ServerCog,
} from "lucide-react";

import { BrandMark } from "@/components/layout/app-shell";
import {
  AnimatedNumber,
  DynamicNounTypewriter,
  Reveal,
  SignatureTypewriter,
  SpotlightCard,
  usePrefersReducedMotion,
} from "@/components/landing/scroll-reveal";
import {
  FileUploadZone,
  type UploadFormat,
} from "@/components/landing/file-upload-zone";
import { CapabilitiesSection } from "@/components/landing/capabilities-section";
import { McpAccessDialog } from "@/components/mcp/mcp-access-dialog";
import { ModeToggle } from "@/components/ui/mode-toggle";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api";
import { warmUpStreamOrigin } from "@/lib/stream-chat";

const CHAPTERS = [
  { id: "hero", num: "01", label: "Launch" },
  { id: "capabilities", num: "02", label: "Capabilities" },
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
    label: "Runtime Memory",
    before: "280 MB",
    from: 280,
    to: 25,
    suffix: " MB",
    note: "Go binary · 60 fps SSE",
    barPct: "9%",
  },
] as const;

const EDGE_ROWS = [
  {
    num: "01",
    title: "Zero Auth",
    summary: "Paste any public repo or drop a PDF, notebook, config, or EPUB.",
    tag: "MULTI-SOURCE",
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
    title: "Exact Citations",
    summary: "Every answer links directly to file lines, pages, cells, chapters, or blocks.",
    tag: "VERIFIABLE",
  },
  {
    num: "04",
    title: "Adaptive Depth",
    summary: "Short lookups stay short. Traces go deep.",
    tag: "4-TIER",
  },
] as const;

const HERO_NOUN_CANDIDATES = ["Repository", "PDF", "Notebook", "Infra", "EPUB"] as const;

type HeroSegment = "repo" | "pdf" | "devdocs";
type DevDocsSubFormat = "notebook" | "iac" | "epub";

const DEV_DOCS_OPTIONS: {
  id: DevDocsSubFormat;
  pillLabel: string;
  title: string;
  exts: string;
  description: string;
  noun: string;
  tagline: string;
}[] = [
  {
    id: "notebook",
    pillLabel: "Jupyter",
    title: "Jupyter Notebook",
    exts: ".ipynb",
    description: "Pairs markdown notes with code cells; strips plot bloat",
    noun: "Notebook",
    tagline: "Query notebook logic & data pipelines — plot bloat stripped automatically.",
  },
  {
    id: "iac",
    pillLabel: "IaC",
    title: "IaC & CI/CD",
    exts: ".tf, Dockerfile, .yml",
    description: "Splits by Terraform resource, Docker stage, or CI job",
    noun: "Infra",
    tagline: "Inspect Terraform resources, Docker stages & CI workflows block by block.",
  },
  {
    id: "epub",
    pillLabel: "EPUB",
    title: "EPUB Spec / Book",
    exts: ".epub",
    description: "Chapter-indexed technical books & architecture manuals",
    noun: "EPUB",
    tagline: "Navigate technical books & architecture specs chapter by chapter.",
  },
];

export default function HomePage() {
  const [heroSegment, setHeroSegment] = useState<HeroSegment>("repo");
  const [devSubFormat, setDevSubFormat] = useState<DevDocsSubFormat>("notebook");
  const [devMenuOpen, setDevMenuOpen] = useState(false);
  const [focusedMenuIdx, setFocusedMenuIdx] = useState(0);
  const [repoUrl, setRepoUrl] = useState("");
  const [error, setError] = useState("");
  const [isClicked, setIsClicked] = useState(false);

  const devMenuContainerRef = useRef<HTMLDivElement>(null);
  const devMenuItemRefs = useRef<(HTMLButtonElement | null)[]>([]);

  const activeDevOption =
    DEV_DOCS_OPTIONS.find((opt) => opt.id === devSubFormat) ?? DEV_DOCS_OPTIONS[0];
  const activeUploadFormat: UploadFormat =
    heroSegment === "pdf" ? "pdf" : devSubFormat;
  const heroNoun =
    heroSegment === "repo"
      ? "Repository"
      : heroSegment === "pdf"
        ? "PDF"
        : activeDevOption.noun;
  const heroTagline =
    heroSegment === "repo"
      ? "Paste a GitHub URL. Get line-cited answers in seconds."
      : heroSegment === "pdf"
        ? "Drop any PDF document. Get page-cited answers in seconds."
        : activeDevOption.tagline;

  useEffect(() => {
    if (!devMenuOpen) return;
    const handlePointerDown = (event: MouseEvent) => {
      if (
        devMenuContainerRef.current &&
        !devMenuContainerRef.current.contains(event.target as Node)
      ) {
        setDevMenuOpen(false);
      }
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setDevMenuOpen(false);
      } else if (event.key === "ArrowDown") {
        event.preventDefault();
        setFocusedMenuIdx((prev) => {
          const next = (prev + 1) % DEV_DOCS_OPTIONS.length;
          devMenuItemRefs.current[next]?.focus();
          return next;
        });
      } else if (event.key === "ArrowUp") {
        event.preventDefault();
        setFocusedMenuIdx((prev) => {
          const next = (prev - 1 + DEV_DOCS_OPTIONS.length) % DEV_DOCS_OPTIONS.length;
          devMenuItemRefs.current[next]?.focus();
          return next;
        });
      }
    };
    document.addEventListener("mousedown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("mousedown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [devMenuOpen]);

  const handleDetectedUploadFormat = useCallback((detected: UploadFormat) => {
    setError("");
    setDevMenuOpen(false);
    if (detected === "pdf") {
      setHeroSegment("pdf");
    } else {
      setDevSubFormat(detected);
      setHeroSegment("devdocs");
    }
  }, []);

  const [activeChapter, setActiveChapter] = useState(0);
  const [mcpDialogOpen, setMcpDialogOpen] = useState(false);
  const [revealed, setRevealed] = useState<boolean[]>([true, false, false, false, false]);

  const hasClickedRef = useRef(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const scrollRootRef = useRef<HTMLDivElement>(null);
  const heroStageRef = useRef<HTMLElement>(null);
  const progressBarRef = useRef<HTMLDivElement>(null);
  const heroBgRef = useRef<HTMLImageElement>(null);
  const orbitalBgRef = useRef<HTMLImageElement>(null);
  const ascentBgRef = useRef<HTMLImageElement>(null);
  const edgeBgRef = useRef<HTMLImageElement>(null);
  const earthBgRef = useRef<HTMLImageElement>(null);

  const chapterStopsRef = useRef<(HTMLElement | null)[]>([null, null, null, null, null]);

  const reducedMotion = usePrefersReducedMotion();
  const router = useRouter();

  // Wake a sleeping Render backend & warm direct stream origin while user is on landing page
  useEffect(() => {
    void fetch("/backend/api/health", { cache: "no-store" }).catch(() => {});
    warmUpStreamOrigin();
  }, []);

  // Continuous 60fps scroll-driven telemetry: progress rail, parallax depth, and 5 discrete 100dvh chapters
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

      const stops = chapterStopsRef.current;
      const midpoint = scrollTop + vh * 0.45;
      const revealLine = scrollTop + vh * 0.88;

      let nextChapter = 0;
      for (let i = 0; i < stops.length; i++) {
        const el = stops[i];
        if (el && el.offsetTop <= midpoint) {
          nextChapter = i;
        }
      }

      setActiveChapter((prev) => (prev === nextChapter ? prev : nextChapter));
      setRevealed((prev) => {
        let changed = false;
        const copy = [...prev];
        for (let i = 0; i < stops.length; i++) {
          const el = stops[i];
          if (!copy[i] && (i === nextChapter || (el && el.offsetTop <= revealLine))) {
            copy[i] = true;
            changed = true;
          }
        }
        return changed ? copy : prev;
      });

      if (!reducedMotion) {
        const stopTop = (index: number) => stops[index]?.offsetTop ?? vh * index;
        if (heroBgRef.current) {
          const heroDelta = Math.min(1.2, Math.max(-0.5, (scrollTop - stopTop(0)) / vh));
          heroBgRef.current.style.transform = `translate3d(0, ${heroDelta * -46}px, 0) scale(${1.03 + heroDelta * 0.05})`;
        }
        if (orbitalBgRef.current) {
          const capOffset = Math.min(1.2, Math.max(-1.2, (scrollTop - stopTop(1)) / vh));
          orbitalBgRef.current.style.transform = `translate3d(0, ${capOffset * -36}px, 0) scale(${1.05 + Math.abs(capOffset) * 0.05})`;
        }
        if (ascentBgRef.current) {
          const benchOffset = Math.min(1.2, Math.max(-1.2, (scrollTop - stopTop(2)) / vh));
          ascentBgRef.current.style.transform = `translate3d(0, ${benchOffset * -42}px, 0) scale(${1.05 + Math.abs(benchOffset) * 0.05})`;
        }
        if (edgeBgRef.current) {
          const edgeOffset = Math.min(1.2, Math.max(-1.2, (scrollTop - stopTop(3)) / vh));
          edgeBgRef.current.style.transform = `translate3d(0, ${edgeOffset * -38}px, 0) scale(${1.05 + Math.abs(edgeOffset) * 0.05})`;
        }
        if (earthBgRef.current) {
          const sigOffset = Math.min(1.2, Math.max(-1.2, (scrollTop - stopTop(4)) / vh));
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
      const target = chapterStopsRef.current[chapterIndex];
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

          <div className="flex items-center gap-3.5 sm:gap-5">
            <span className="tabular-telemetry hidden font-mono text-[10px] tracking-[0.18em] text-muted-foreground uppercase md:inline">
              {CHAPTERS[activeChapter]?.num} / 0{CHAPTERS.length} ·{" "}
              {CHAPTERS[activeChapter]?.label}
            </span>
            <Link
              href="/docs"
              className="group relative font-heading text-xs font-semibold tracking-[0.16em] text-muted-foreground uppercase transition-colors hover:text-foreground"
            >
              <span>Docs</span>
              <span className="absolute -bottom-1 left-0 h-px w-full origin-left scale-x-0 bg-foreground transition-transform duration-300 group-hover:scale-x-100" />
            </Link>
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

      {/* Strict 100dvh snap on desktop, adaptive proximity flow on mobile so zero content clips */}
      <div
        ref={scrollRootRef}
        className="h-[100dvh] w-full snap-y snap-proximity overflow-x-hidden overflow-y-auto scroll-smooth md:snap-mandatory"
      >
        {/* =====================================================================
            SECTION 01 — HERO (100dvh on desktop, adaptive min-h on mobile)
           ===================================================================== */}
        <section
          id="hero"
          ref={(el) => {
            heroStageRef.current = el;
            chapterStopsRef.current[0] = el;
          }}
          onPointerMove={handleHeroPointerMove}
          className="relative flex min-h-[100dvh] w-full snap-start flex-col overflow-x-clip pt-14 md:h-[100dvh] md:snap-always md:overflow-hidden"
        >
          <div className="pointer-events-none absolute inset-0 overflow-hidden select-none">
            <img
              ref={heroBgRef}
              src="/images/spacex-launch-arc.jpg"
              alt=""
              aria-hidden="true"
              className="h-full w-full scale-[1.03] object-cover object-[72%_35%] opacity-[0.22] will-change-transform sm:object-right-bottom dark:opacity-[0.32] [mask-image:radial-gradient(ellipse_80%_75%_at_75%_55%,black_25%,transparent_100%)]"
            />
            <div className="mission-grid absolute inset-0 opacity-55" />
            <div className="hero-spotlight absolute inset-0 transition-opacity duration-500" />
          </div>

          <main className="relative z-10 mx-auto flex w-full max-w-6xl flex-1 flex-col justify-between px-4 py-6 sm:px-6 sm:py-10">
            <div />

            {/* Clean centered/editorial focal stack */}
            <div className="max-w-2xl space-y-5 sm:space-y-7">
              {/* 3-segment source mode switcher + quiet MCP access trigger */}
              <div className="hero-fade-reveal relative z-30 flex flex-wrap items-center gap-2 sm:gap-2.5" style={{ animationDelay: "20ms" }}>
                <div
                  ref={devMenuContainerRef}
                  className="relative inline-block max-w-full"
                >
                <div
                  className="inline-flex max-w-full items-center rounded-[2px] border border-border/90 bg-background/85 p-0.5 backdrop-blur-md"
                  role="tablist"
                  aria-label="Knowledge source type"
                >
                  <button
                    type="button"
                    role="tab"
                    aria-selected={heroSegment === "repo"}
                    onClick={() => {
                      setHeroSegment("repo");
                      setDevMenuOpen(false);
                      setError("");
                    }}
                    className={`inline-flex items-center gap-1.5 rounded-[1px] px-2.5 py-2 font-mono text-[10px] font-medium tracking-[0.14em] uppercase transition-all duration-200 sm:px-3 sm:py-1.5 sm:tracking-[0.16em] ${
                      heroSegment === "repo"
                        ? "bg-foreground text-background"
                        : "text-muted-foreground hover:text-foreground"
                    }`}
                  >
                    <GitBranch className="size-3" />
                    <span>GitHub</span>
                  </button>

                  <button
                    type="button"
                    role="tab"
                    aria-selected={heroSegment === "pdf"}
                    onClick={() => {
                      setHeroSegment("pdf");
                      setDevMenuOpen(false);
                      setError("");
                    }}
                    className={`inline-flex items-center gap-1.5 rounded-[1px] px-2.5 py-2 font-mono text-[10px] font-medium tracking-[0.14em] uppercase transition-all duration-200 sm:px-3 sm:py-1.5 sm:tracking-[0.16em] ${
                      heroSegment === "pdf"
                        ? "bg-foreground text-background"
                        : "text-muted-foreground hover:text-foreground"
                    }`}
                  >
                    <FileText className="size-3" />
                    <span>PDF</span>
                  </button>

                  <button
                    type="button"
                    role="tab"
                    aria-selected={heroSegment === "devdocs"}
                    aria-haspopup="menu"
                    aria-expanded={devMenuOpen}
                    onClick={() => {
                      if (heroSegment !== "devdocs") {
                        setHeroSegment("devdocs");
                        setDevMenuOpen(true);
                      } else {
                        setDevMenuOpen((open) => !open);
                      }
                      setError("");
                    }}
                    className={`inline-flex items-center gap-1.5 rounded-[1px] px-2.5 py-2 font-mono text-[10px] font-medium tracking-[0.14em] uppercase transition-all duration-200 sm:px-3 sm:py-1.5 sm:tracking-[0.16em] ${
                      heroSegment === "devdocs"
                        ? "bg-foreground text-background"
                        : "text-muted-foreground hover:text-foreground"
                    }`}
                  >
                    <Layers className="size-3" />
                    <span>
                      {heroSegment === "devdocs" ? activeDevOption.pillLabel : "Dev Docs"}
                    </span>
                    <ChevronDown
                      className={`size-3 transition-transform duration-200 ${
                        devMenuOpen ? "rotate-180" : ""
                      }`}
                    />
                  </button>
                </div>

                {devMenuOpen && (
                  <div
                    role="menu"
                    aria-label="Developer document formats"
                    className="absolute top-full left-0 z-50 mt-1.5 w-[min(22rem,calc(100vw-2rem))] rounded-[2px] border border-border bg-card/98 p-1 shadow-2xl backdrop-blur-md"
                  >
                    {DEV_DOCS_OPTIONS.map((option, idx) => {
                      const isSelected = heroSegment === "devdocs" && devSubFormat === option.id;
                      const OptionIcon =
                        option.id === "notebook"
                          ? FileCode2
                          : option.id === "iac"
                            ? ServerCog
                            : BookOpen;
                      return (
                        <button
                          key={option.id}
                          ref={(el) => {
                            devMenuItemRefs.current[idx] = el;
                          }}
                          type="button"
                          role="menuitemradio"
                          aria-checked={isSelected}
                          onMouseEnter={() => setFocusedMenuIdx(idx)}
                          onClick={() => {
                            setDevSubFormat(option.id);
                            setHeroSegment("devdocs");
                            setDevMenuOpen(false);
                            setError("");
                          }}
                          className={`flex w-full items-start gap-3 rounded-[1px] px-3 py-2.5 text-left transition-colors focus-visible:outline-none ${
                            isSelected || focusedMenuIdx === idx
                              ? "bg-foreground/[0.08] text-foreground"
                              : "text-muted-foreground hover:bg-foreground/[0.05] hover:text-foreground"
                          }`}
                        >
                          <div className="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-[2px] border border-border bg-background/80 text-foreground">
                            <OptionIcon className="size-3.5" />
                          </div>
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center justify-between gap-2">
                              <span className="font-heading text-xs font-semibold tracking-[0.08em] text-foreground uppercase">
                                {option.title}
                              </span>
                              <span className="font-mono text-[9px] tracking-[0.08em] text-muted-foreground">
                                {option.exts}
                              </span>
                            </div>
                            <p className="mt-0.5 text-[11px] leading-snug text-muted-foreground">
                              {option.description}
                            </p>
                          </div>
                          {isSelected && (
                            <Check className="mt-1 size-3.5 shrink-0 text-foreground" />
                          )}
                        </button>
                      );
                    })}
                  </div>
                )}
                </div>

                <button
                  type="button"
                  onClick={() => setMcpDialogOpen(true)}
                  className="group inline-flex items-center gap-1.5 rounded-[2px] border border-border/80 bg-background/75 px-3 py-1.5 font-mono text-[10px] font-medium tracking-[0.14em] text-muted-foreground uppercase backdrop-blur-md transition-all duration-200 hover:border-foreground hover:text-foreground"
                >
                  <KeyRound className="size-3 text-foreground/80" />
                  <span>MCP Access</span>
                  <ArrowUpRight className="size-3 opacity-60 transition-transform duration-200 group-hover:translate-x-0.5 group-hover:-translate-y-0.5 group-hover:opacity-100" />
                </button>
              </div>

              <div className="space-y-3 sm:space-y-4">
                <h1
                  className="hero-mask-reveal font-heading text-[2.1rem] leading-[1.02] font-semibold tracking-[0.04em] uppercase sm:text-6xl sm:leading-[0.98] lg:text-[4.5rem]"
                  style={{ animationDelay: "60ms" }}
                >
                  Interrogate Any{" "}
                  <DynamicNounTypewriter
                    target={heroNoun}
                    candidates={HERO_NOUN_CANDIDATES}
                    reducedMotion={reducedMotion}
                  />
                </h1>
                <p
                  className="hero-mask-reveal max-w-lg text-sm leading-relaxed text-muted-foreground sm:text-lg"
                  style={{ animationDelay: "150ms" }}
                >
                  {heroTagline}
                </p>
              </div>

              <div
                className="hero-mask-reveal min-h-[108px] space-y-3 sm:min-h-[96px]"
                style={{ animationDelay: "230ms" }}
              >
                {heroSegment === "repo" ? (
                  <>
                    <div className="group/bar flex flex-col border border-input bg-background/85 backdrop-blur-sm transition-all duration-200 hover:border-foreground/50 focus-within:border-foreground sm:flex-row">
                      <div className="flex min-w-0 flex-1 items-center">
                        <div className="flex shrink-0 items-center border-r border-border/70 px-3 py-2 font-mono text-[11px] tracking-[0.12em] text-muted-foreground uppercase transition-colors group-focus-within/bar:text-foreground sm:px-3.5">
                          GIT
                        </div>
                        <input
                          ref={inputRef}
                          type="url"
                          inputMode="url"
                          autoCapitalize="none"
                          autoCorrect="off"
                          spellCheck={false}
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
                          className="h-12 min-w-0 flex-1 bg-transparent px-3 font-mono text-base tracking-wide text-foreground outline-none placeholder:text-xs placeholder:text-muted-foreground/60 sm:px-4 sm:text-sm sm:placeholder:text-sm"
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
                  </>
                ) : (
                  <FileUploadZone
                    format={activeUploadFormat}
                    onFormatDetected={handleDetectedUploadFormat}
                    onUploaded={(source) => {
                      router.push(`/chat/${source.id}`);
                    }}
                  />
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

                <span>Scroll · Capabilities &amp; MCP</span>

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
            SECTION 02 — CAPABILITIES & MCP SHOWCASE (100dvh, zero bleed)
           ===================================================================== */}
        <CapabilitiesSection
          visible={revealed[1]}
          sectionRef={(el) => {
            chapterStopsRef.current[1] = el;
          }}
          bgRef={orbitalBgRef}
          onOpenMcpModal={() => setMcpDialogOpen(true)}
          onNextSection={() => scrollToChapter(2)}
        />

        {/* =====================================================================
            SECTION 03 — BENCHMARKS (100dvh on desktop, adaptive on mobile)
           ===================================================================== */}
        <section
          id="latency"
          ref={(el) => {
            chapterStopsRef.current[2] = el;
          }}
          className="relative flex min-h-[100dvh] w-full snap-start flex-col overflow-x-clip border-t border-border/60 pt-14 md:h-[100dvh] md:snap-always md:overflow-hidden"
        >
          <div className="pointer-events-none absolute inset-0 overflow-hidden select-none">
            <img
              ref={ascentBgRef}
              src="/images/falcon-ascent.jpg"
              alt=""
              aria-hidden="true"
              className="h-full w-full scale-105 object-cover object-center opacity-[0.16] will-change-transform dark:opacity-[0.28] [mask-image:radial-gradient(ellipse_75%_75%_at_55%_50%,black_25%,transparent_100%)]"
            />
            <div className="mission-grid absolute inset-0 opacity-40" />
          </div>

          <div className="relative z-10 mx-auto flex w-full max-w-6xl flex-1 flex-col justify-between gap-5 px-4 py-5 sm:gap-7 sm:px-6 sm:py-7 md:py-9">
            <Reveal visible={revealed[2]} className="space-y-1.5">
              <p className="font-mono text-[10px] tracking-[0.22em] text-muted-foreground uppercase">
                02 // BENCHMARKS
              </p>
              <h2 className="font-heading text-2xl leading-[1.04] font-semibold tracking-[0.04em] uppercase sm:text-4xl lg:text-5xl">
                Fast by architecture.
              </h2>
            </Reveal>

            {/* Spacious 2x2 high-contrast telemetry grid — effortless to scan on mobile & desktop */}
            <div className="grid grid-cols-1 gap-2.5 min-[380px]:grid-cols-2 sm:gap-5">
              {BENCHMARK_CARDS.map((card, idx) => (
                <Reveal key={card.code} visible={revealed[2]} delay={70 + idx * 75}>
                  <SpotlightCard className="group flex h-full flex-col justify-between border border-border/80 bg-card/70 p-3.5 sm:p-5">
                    <div className="flex flex-wrap items-center justify-between gap-x-2 gap-y-0.5 font-mono text-[10px] tracking-[0.12em] text-muted-foreground uppercase sm:tracking-[0.14em]">
                      <span>{card.label}</span>
                      <span className="tabular-telemetry line-through opacity-55">
                        {card.before}
                      </span>
                    </div>

                    <div className="my-2.5 sm:my-4">
                      <p className="font-heading text-2xl leading-none font-semibold tracking-[0.02em] text-foreground min-[380px]:text-3xl sm:text-5xl lg:text-[3.25rem]">
                        <AnimatedNumber
                          from={card.from}
                          to={card.to}
                          suffix={card.suffix}
                          active={revealed[2]}
                          reducedMotion={reducedMotion}
                        />
                      </p>
                      <p className="mt-2 font-mono text-[10px] tracking-[0.08em] text-muted-foreground uppercase sm:text-[11px] sm:tracking-[0.1em]">
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
              className="flex flex-wrap items-center justify-between gap-2 border-t border-border/70 pt-3 font-mono text-[10px] tracking-[0.14em] text-muted-foreground uppercase sm:tracking-[0.16em]"
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
            SECTION 04 — THE EDGE (100dvh on desktop, adaptive on mobile)
           ===================================================================== */}
        <section
          id="edge"
          ref={(el) => {
            chapterStopsRef.current[3] = el;
          }}
          className="relative flex min-h-[100dvh] w-full snap-start flex-col overflow-x-clip border-t border-border/60 pt-14 md:h-[100dvh] md:snap-always md:overflow-hidden"
        >
          <div className="pointer-events-none absolute inset-0 overflow-hidden select-none">
            <img
              ref={edgeBgRef}
              src="/images/orbital-instrument.jpg"
              alt=""
              aria-hidden="true"
              className="h-full w-full scale-105 object-cover object-[70%_30%] opacity-[0.12] will-change-transform dark:opacity-[0.17] [mask-image:radial-gradient(ellipse_75%_75%_at_75%_45%,black_15%,transparent_100%)]"
            />
            <div className="mission-grid absolute inset-0 opacity-35" />
          </div>

          <div className="relative z-10 mx-auto flex w-full max-w-6xl flex-1 flex-col justify-between gap-5 px-4 py-5 sm:gap-7 sm:px-6 sm:py-7 md:py-9">
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
                  <span>Try a Source</span>
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
            SECTION 05 — CLOSING / SIGNATURE (100dvh on desktop, adaptive on mobile)
           ===================================================================== */}
        <section
          id="signature"
          ref={(el) => {
            chapterStopsRef.current[4] = el;
          }}
          className="relative flex min-h-[100dvh] w-full snap-start flex-col overflow-x-clip border-t border-border/60 pt-14 md:h-[100dvh] md:snap-always md:overflow-hidden"
        >
          <div className="pointer-events-none absolute inset-0 overflow-hidden select-none">
            <img
              ref={earthBgRef}
              src="/images/earth-dark.jpg"
              alt=""
              aria-hidden="true"
              className="h-full w-full scale-105 object-cover object-center opacity-[0.14] will-change-transform dark:opacity-[0.22] [mask-image:radial-gradient(ellipse_68%_65%_at_50%_55%,black_20%,transparent_100%)]"
            />
            <svg
              aria-hidden="true"
              viewBox="0 0 600 600"
              className="orbital-spin absolute top-1/2 left-1/2 size-[280px] -translate-x-1/2 -translate-y-1/2 opacity-[0.14] sm:size-[540px]"
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

            <footer className="flex flex-wrap items-center justify-between gap-3 border-t border-border/60 pt-4 pb-[env(safe-area-inset-bottom)] font-mono text-[10px] tracking-[0.16em] text-muted-foreground/75 uppercase">
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

      <McpAccessDialog open={mcpDialogOpen} onOpenChange={setMcpDialogOpen} />
    </div>
  );
}
