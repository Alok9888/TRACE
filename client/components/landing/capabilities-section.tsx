"use client";

import Link from "next/link";
import type { RefObject } from "react";
import { ArrowDown, ArrowRight, Cpu, KeyRound, Layers, Terminal, Wrench } from "lucide-react";

import { Reveal, SpotlightCard } from "@/components/landing/scroll-reveal";

const CAPABILITY_CARDS = [
  {
    code: "01",
    icon: Terminal,
    title: "Native MCP Support",
    summary:
      "Standards-compliant Streamable HTTP JSON-RPC server scoped per workspace via SHA-256 Bearer keys. Plug straight into Cursor, Claude Desktop, VS Code, or Windsurf.",
    meta: "POST /api/mcp · BEARER AUTH",
  },
  {
    code: "02",
    icon: Layers,
    title: "Multi-Source Pipeline",
    summary:
      "GitHub repositories, PDFs, Jupyter notebooks, Terraform/Docker/CI configs, and EPUB technical books indexed into one unified 384-dim PgVector store.",
    meta: "5 FORMATS · EXACT CITATIONS",
  },
  {
    code: "03",
    icon: Cpu,
    title: "Lightweight & Fast",
    summary:
      "Compiled Go binary running bounded goroutine pools in ~25 MB RAM, 64-chunk batched Cloudflare embeddings, direct CTE PgVector SQL, and 60 fps streamed SSE.",
    meta: "GO · ~25 MB RSS · DIRECT CTE SQL",
  },
  {
    code: "04",
    icon: Wrench,
    title: "Built-in MCP Tools",
    summary:
      "Focused, tenant-isolated tools with strict JSON schemas so agents discover sources, run semantic search, and pull exact excerpts with citations.",
    tools: [
      "list_sources",
      "search_knowledge",
      "get_source_details",
      "get_source_excerpts",
    ],
  },
] as const;

export function CapabilitiesSection({
  visible,
  sectionRef,
  bgRef,
  onOpenMcpModal,
  onNextSection,
}: {
  visible: boolean;
  sectionRef: (el: HTMLElement | null) => void;
  bgRef: RefObject<HTMLImageElement | null>;
  onOpenMcpModal: () => void;
  onNextSection: () => void;
}) {
  return (
    <section
      id="capabilities"
      ref={sectionRef}
      className="relative flex min-h-[100dvh] w-full snap-start flex-col overflow-x-clip border-t border-border/60 pt-14 md:h-[100dvh] md:snap-always md:overflow-hidden"
    >
      <div className="pointer-events-none absolute inset-0 overflow-hidden select-none">
        <img
          ref={bgRef}
          src="/images/orbital-horizon.jpg"
          alt=""
          aria-hidden="true"
          className="h-full w-full scale-105 object-cover object-center opacity-[0.14] will-change-transform dark:opacity-[0.22] [mask-image:radial-gradient(ellipse_80%_70%_at_55%_55%,black_20%,transparent_100%)]"
        />
        <div className="mission-grid absolute inset-0 opacity-45" />
      </div>

      <div className="relative z-10 mx-auto flex w-full max-w-6xl flex-1 flex-col justify-between gap-4 px-4 py-5 sm:gap-6 sm:px-6 sm:py-7 md:py-9">
        {/* Crisp section header */}
        <Reveal
          visible={visible}
          className="flex flex-col justify-between gap-3 sm:flex-row sm:items-end"
        >
          <div className="space-y-1.5">
            <p className="font-mono text-[10px] tracking-[0.22em] text-muted-foreground uppercase">
              01 // CAPABILITIES
            </p>
            <h2 className="font-heading text-2xl leading-[1.04] font-semibold tracking-[0.04em] uppercase sm:text-4xl lg:text-5xl">
              Built for agents &amp; engineers.
            </h2>
          </div>

          <Link
            href="/docs"
            className="group inline-flex w-fit items-center gap-2 rounded-[2px] border border-foreground/45 bg-background/80 px-3.5 py-2 font-mono text-[10px] font-medium tracking-[0.16em] text-foreground uppercase backdrop-blur-sm transition-all duration-200 hover:border-foreground hover:bg-foreground hover:text-background"
          >
            <span>Read MCP Setup Docs</span>
            <ArrowRight className="size-3 transition-transform duration-200 group-hover:translate-x-0.5" />
          </Link>
        </Reveal>

        {/* 2x2 high-signal capability showcase */}
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 sm:gap-4 md:gap-5">
          {CAPABILITY_CARDS.map((card, idx) => {
            const Icon = card.icon;
            return (
              <Reveal key={card.code} visible={visible} delay={70 + idx * 65}>
                <SpotlightCard className="group flex h-full flex-col justify-between border border-border/80 bg-card/75 p-3.5 backdrop-blur-sm sm:p-5">
                  <div className="flex min-w-0 items-center justify-between gap-2 font-mono text-[10px] tracking-[0.14em] text-muted-foreground uppercase sm:tracking-[0.16em]">
                    <span className="inline-flex shrink-0 items-center gap-2">
                      <Icon className="size-3.5 text-foreground/80" />
                      <span>{card.code}</span>
                    </span>
                    {"meta" in card ? (
                      <span className="min-w-0 truncate text-right opacity-75">{card.meta}</span>
                    ) : (
                      <span className="shrink-0 opacity-75">4 TOOLS</span>
                    )}
                  </div>

                  <div className="my-2 sm:my-3">
                    <h3 className="font-heading text-base font-semibold tracking-[0.06em] text-foreground uppercase sm:text-lg">
                      {card.title}
                    </h3>
                    <p className="mt-1 text-xs leading-relaxed text-muted-foreground sm:text-[13px]">
                      {card.summary}
                    </p>
                  </div>

                  {"tools" in card ? (
                    <div className="flex flex-wrap gap-1.5 pt-1">
                      {card.tools.map((toolName) => (
                        <code
                          key={toolName}
                          className="rounded-[2px] border border-border/90 bg-background/80 px-2 py-0.5 font-mono text-[10px] text-foreground/90"
                        >
                          {toolName}
                        </code>
                      ))}
                    </div>
                  ) : (
                    <div className="h-px w-full bg-border/50" />
                  )}
                </SpotlightCard>
              </Reveal>
            );
          })}
        </div>

        {/* Footer telemetry bar */}
        <Reveal
          visible={visible}
          delay={300}
          className="flex flex-wrap items-center justify-between gap-3 border-t border-border/70 pt-3 font-mono text-[10px] tracking-[0.16em] text-muted-foreground uppercase"
        >
          <div className="flex items-center gap-4">
            <button
              type="button"
              onClick={onOpenMcpModal}
              className="inline-flex items-center gap-1.5 text-foreground/85 transition-colors hover:text-foreground"
            >
              <KeyRound className="size-3" />
              <span>Generate MCP Key</span>
            </button>
            <span className="hidden opacity-40 sm:inline">·</span>
            <Link
              href="/docs"
              className="hidden items-center gap-1 text-muted-foreground transition-colors hover:text-foreground sm:inline-flex"
            >
              <span>Docs</span>
              <ArrowRight className="size-3" />
            </Link>
          </div>

          <button
            type="button"
            onClick={onNextSection}
            className="group inline-flex items-center gap-1.5 text-foreground/85 transition-colors hover:text-foreground"
          >
            <span>Benchmarks</span>
            <ArrowDown className="size-3 transition-transform duration-200 group-hover:translate-y-0.5" />
          </button>
        </Reveal>
      </div>
    </section>
  );
}
