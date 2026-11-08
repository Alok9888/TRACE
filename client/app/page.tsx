"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowRight } from "lucide-react";

import { BrandMark } from "@/components/layout/app-shell";
import { ModeToggle } from "@/components/ui/mode-toggle";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api";

export default function HomePage() {
  const [repoUrl, setRepoUrl] = useState("");
  const [error, setError] = useState("");
  const [isClicked, setIsClicked] = useState(false);
  const hasClickedRef = useRef(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const router = useRouter();

  // Wake a sleeping Render backend while the user is pasting a GitHub URL
  useEffect(() => {
    void fetch("/backend/api/health", { cache: "no-store" }).catch(() => {});
  }, []);

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

    const slug = `${match[1]}-${match[2].replace(/\.git$/, "")}`.toLowerCase();
    hasClickedRef.current = true;
    router.push(`/chat/${slug}?url=${encodeURIComponent(repoUrl.trim())}`);
    setIsClicked(true);
    setError("");
    void api.analyzeRepo(repoUrl.trim()).catch((err) => {
      setError(err instanceof Error ? err.message : "Could not analyze repository");
    });
  }

  return (
    <div className="relative flex min-h-svh flex-col overflow-x-clip bg-background text-foreground">
      {/* Real monochrome SpaceX night-launch photography — subtle, low-opacity atmospheric backdrop */}
      <div className="pointer-events-none absolute inset-0 overflow-hidden select-none">
        <img
          src="/images/spacex-launch-arc.jpg"
          alt=""
          aria-hidden="true"
          className="h-full w-full object-cover object-[72%_35%] opacity-[0.22] contrast-125 sm:object-right-bottom dark:opacity-[0.30] [mask-image:radial-gradient(ellipse_80%_75%_at_75%_55%,black_25%,transparent_100%)]"
        />
        <div className="mission-grid absolute inset-0 opacity-60" />
      </div>

      {/* Top mission bar */}
      <header className="sticky top-0 z-30 border-b border-border/80 bg-background/75 backdrop-blur-md">
        <div className="mx-auto flex h-14 w-full max-w-6xl items-center justify-between px-4 sm:px-6">
          <BrandMark />
          <div className="flex items-center gap-4 sm:gap-5">
            <Link
              href="/dashboard"
              className="font-heading text-xs font-semibold tracking-[0.16em] text-muted-foreground uppercase transition-colors hover:text-foreground"
            >
              Repositories
            </Link>
            <ModeToggle />
          </div>
        </div>
      </header>

      {/* Main asymmetric editorial hero */}
      <main className="relative z-10 mx-auto flex w-full max-w-6xl flex-1 flex-col justify-between px-4 py-10 sm:px-6 sm:py-16 md:py-24">
        <section className="max-w-2xl space-y-6 pt-2 sm:space-y-8 sm:pt-4 md:pt-10">
          <div className="space-y-3 sm:space-y-4">
            <p className="font-mono text-[10px] tracking-[0.22em] text-muted-foreground uppercase sm:text-[11px]">
              CODEBASE INTELLIGENCE
            </p>
            <h1 className="font-heading text-[2.25rem] leading-[1.02] font-semibold tracking-[0.03em] uppercase sm:text-6xl">
              Understand Any Repository.
            </h1>
            <p className="max-w-lg text-sm leading-relaxed text-muted-foreground sm:text-base">
              Index public GitHub repositories and ask direct questions about architecture,
              control flow, and symbols with line-level citations.
            </p>
          </div>

          {/* Launch command input bar */}
          <div className="space-y-3 pt-1 sm:pt-2">
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
                  className="h-12 min-w-0 flex-1 bg-transparent px-3 font-mono text-xs tracking-wide text-foreground outline-none placeholder:text-muted-foreground/60 sm:px-4 sm:text-sm"
                />
              </div>
              <Button
                variant="outline"
                size="lg"
                onClick={analyze}
                disabled={isClicked}
                className={`h-12 rounded-none border-0 border-t border-input bg-transparent px-7 text-foreground hover:bg-foreground hover:text-background sm:border-t-0 sm:border-l ${
                  isClicked
                    ? "pointer-events-none opacity-60"
                    : ""
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
              <p
                role="alert"
                className="font-mono text-xs tracking-wide text-destructive"
              >
                {error}
              </p>
            ) : (
              <p className="font-mono text-[10px] tracking-[0.12em] text-muted-foreground/75 uppercase sm:text-[11px]">
                Public GitHub repositories · No sign-in required
              </p>
            )}
          </div>
        </section>

        {/* Bottom architectural spec strip */}
        <section className="mt-12 grid gap-6 border-t border-border/80 pt-6 sm:mt-20 sm:gap-8 sm:pt-8 md:grid-cols-3">
          {[
            {
              index: "01",
              title: "INGEST",
              body: "Streams repository archives and filters generated assets before chunking.",
            },
            {
              index: "02",
              title: "INDEX",
              body: "Line-aligned code segments embedded and stored in Postgres with pgvector.",
            },
            {
              index: "03",
              title: "QUERY",
              body: "Streaming answers grounded in retrieved source ranges and direct file links.",
            },
          ].map((item) => (
            <div key={item.index} className="space-y-2.5">
              <div className="flex items-center gap-3 font-mono text-[11px] tracking-[0.2em] text-muted-foreground">
                <span>{item.index}</span>
                <span className="h-px w-6 bg-border" />
                <span className="font-heading text-xs font-semibold tracking-[0.18em] text-foreground">
                  {item.title}
                </span>
              </div>
              <p className="text-xs leading-relaxed text-muted-foreground">
                {item.body}
              </p>
            </div>
          ))}
        </section>
      </main>
    </div>
  );
}
