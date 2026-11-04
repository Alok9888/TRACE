"use client";

import { useEffect, useRef, useState } from "react";
import { AlertCircle, Loader2, RotateCcw, CheckCircle } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { Progress } from "@/components/ui/progress";
import { getRepoProgress, useStartIndexing } from "@/hooks/use-repos";
import type { IndexStatusResponse, Repository } from "@/lib/api";

const STAGES = [
  { key: "creating", num: "01", label: "INIT" },
  { key: "fetching", num: "02", label: "INGEST" },
  { key: "chunking", num: "03", label: "SEGMENT" },
  { key: "embedding", num: "04", label: "VECTORIZE" },
  { key: "saving", num: "05", label: "COMMIT" },
  { key: "done", num: "06", label: "ONLINE" },
] as const;

const SUBTEXTS: Record<string, string[]> = {
  creating: [
    "Initializing repository telemetry...",
    "Resolving GitHub metadata...",
    "Validating source tree...",
  ],
  fetching: [
    "Streaming repository archive...",
    "Filtering eligible source files...",
    "Ingesting codebase payloads...",
  ],
  chunking: [
    "Segmenting files on line boundaries...",
    "Mapping line coordinates...",
    "Preparing 64-chunk embedding batches...",
  ],
  embedding: [
    "Computing 384-dim vector embeddings...",
    "Dispatching batched inference...",
    "Writing vectors to pgvector...",
  ],
  saving: [
    "Committing vector index...",
    "Finalizing repository telemetry...",
    "Verifying readiness...",
  ],
  done: [
    "Repository online.",
    "Comms channel unlocked.",
    "Telemetry nominal.",
  ],
};

export function IndexingState({
  repo,
  status,
}: {
  repo: Repository;
  status?: IndexStatusResponse;
}) {
  const indexMutation = useStartIndexing();
  const filesProcessed = status?.filesProcessed ?? repo.filesProcessed;
  const filesTotal = status?.filesTotal ?? repo.filesTotal;
  const chunksTotal = status?.chunksTotal ?? repo.chunkCount;
  const chunksProcessed = status?.chunksProcessed ?? 0;
  const indexStatus = status?.indexStatus ?? repo.indexStatus;
  const errorMessage = status?.errorMessage ?? repo.errorMessage;
  const indexingStage = status?.indexingStage;
  const indexingDetail = status?.indexingDetail;

  // Current stage index for progress display
  const currentStageIndex = STAGES.findIndex((s) => s.key === indexingStage);
  const completedStages = currentStageIndex >= 0 ? currentStageIndex : 0;
  const stageProgress = STAGES.length > 0 ? ((completedStages + 1) / STAGES.length) * 100 : 0;

  // Subtext rotation state
  const [subtext, setSubtext] = useState("");
  const subtextIndexRef = useRef(0);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Rotate subtext every 500ms
  useEffect(() => {
    if (indexStatus === "READY" || indexStatus === "FAILED") return;

    const stageKey = indexingStage ?? "fetching";
    const details = SUBTEXTS[stageKey] ?? SUBTEXTS.fetching;

    // Include detail from backend if available
    const allDetails = indexingDetail
      ? [indexingDetail, ...details.filter(d => d !== indexingDetail)]
      : details;

    // Initial subtext
    setSubtext(allDetails[0]);
    subtextIndexRef.current = 0;

    intervalRef.current = setInterval(() => {
      subtextIndexRef.current = (subtextIndexRef.current + 1) % allDetails.length;
      setSubtext(allDetails[subtextIndexRef.current]);
    }, 2500);

    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [indexingStage, indexingDetail, indexStatus]);

  if (indexStatus === "FAILED") {
    return (
      <Empty className="h-full border-0">
        <EmptyHeader>
          <EmptyMedia variant="icon" className="rounded-[2px] border border-destructive/40 bg-destructive/10">
            <AlertCircle className="size-4 text-destructive" />
          </EmptyMedia>
          <EmptyTitle className="font-heading text-sm font-semibold tracking-[0.16em] uppercase">
            Indexing Fault
          </EmptyTitle>
          <EmptyDescription className="font-mono text-xs text-muted-foreground">
            {errorMessage || "Indexing sequence aborted unexpectedly."}
          </EmptyDescription>
        </EmptyHeader>
        <Button
          onClick={() => indexMutation.mutate(repo.id)}
          disabled={indexMutation.isPending}
        >
          <RotateCcw data-icon="inline-start" />
          Retry Sequence
        </Button>
      </Empty>
    );
  }

  if (indexStatus === "READY") {
    return (
      <Empty className="h-full border-0">
        <EmptyHeader>
          <EmptyMedia variant="icon" className="rounded-[2px] border border-foreground/40 bg-transparent">
            <CheckCircle className="size-4 text-foreground" />
          </EmptyMedia>
          <EmptyTitle className="font-heading text-sm font-semibold tracking-[0.16em] uppercase">
            Telemetry Online
          </EmptyTitle>
          <EmptyDescription className="font-mono text-xs text-muted-foreground">
            {repo.fullName} is indexed and ready for interrogation.
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }

  // Calculate progress based on current stage
  let progress = 0;
  switch (indexingStage) {
    case "creating":
      progress = 5;
      break;
    case "fetching":
      progress = 5 + (filesTotal > 0 ? Math.round((filesProcessed / filesTotal) * 20) : 10);
      break;
    case "chunking":
      progress = 25 + (chunksTotal > 0 ? Math.round((chunksProcessed / chunksTotal) * 20) : 10);
      break;
    case "embedding":
      progress = 45 + (chunksTotal > 0 ? Math.round((chunksProcessed / chunksTotal) * 30) : 15);
      break;
    case "saving":
      progress = 75;
      break;
    case "done":
      progress = 100;
      break;
    default:
      progress = 5;
  }

  const clampedProgress = Math.min(100, Math.max(progress, 5));

  return (
    <div className="relative flex flex-1 flex-col items-center justify-center overflow-hidden p-4 sm:p-6">
      {/* Subtle SpaceX orbital trajectory photograph backdrop */}
      <img
        src="/images/orbital-horizon.jpg"
        alt=""
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 h-full w-full object-cover object-center opacity-[0.12] contrast-125 select-none dark:opacity-[0.18] [mask-image:radial-gradient(ellipse_70%_70%_at_50%_50%,black_20%,transparent_100%)]"
      />
      <div className="mission-grid pointer-events-none absolute inset-0 opacity-50" />

      <div className="relative z-10 w-full max-w-xl space-y-5 border border-border bg-background/85 p-5 backdrop-blur-md sm:space-y-6 sm:p-6 md:p-8">
        <div className="flex items-start justify-between gap-4 border-b border-border pb-4">
          <div className="min-w-0 space-y-1">
            <p className="font-mono text-[10px] tracking-[0.2em] text-muted-foreground uppercase">
              INGESTION SEQUENCE // ACTIVE
            </p>
            <h2 className="truncate font-heading text-lg font-semibold tracking-[0.1em] uppercase">
              {repo.fullName}
            </h2>
          </div>
          <div className="flex items-center gap-2 font-mono text-xs tabular-telemetry text-foreground">
            <Loader2 className="size-3.5 animate-spin text-muted-foreground" />
            <span>{clampedProgress}%</span>
          </div>
        </div>

        {/* Flight-stage matrix */}
        <div className="grid grid-cols-3 gap-2 sm:grid-cols-6">
          {STAGES.map((stage, idx) => {
            const isComplete = idx < completedStages;
            const isActive = idx === completedStages;
            return (
              <div
                key={stage.key}
                className={`flex flex-col gap-1 border px-2.5 py-2 font-mono transition-colors ${
                  isActive
                    ? "border-foreground bg-foreground/[0.08] text-foreground"
                    : isComplete
                      ? "border-foreground/30 bg-transparent text-foreground/75"
                      : "border-border/60 bg-transparent text-muted-foreground/45"
                }`}
              >
                <div className="flex items-center justify-between text-[9px] tracking-[0.16em]">
                  <span>{stage.num}</span>
                  {isActive && (
                    <span className="size-1.5 animate-pulse rounded-full bg-foreground" />
                  )}
                  {isComplete && (
                    <span className="size-1.5 rounded-full bg-foreground/70" />
                  )}
                </div>
                <span className="truncate text-[10px] font-medium tracking-[0.12em]">
                  {stage.label}
                </span>
              </div>
            );
          })}
        </div>

        {/* Progress & live telemetry readouts */}
        <div className="space-y-3">
          <Progress value={clampedProgress} className="h-[2px] rounded-none" />
          <div className="flex flex-wrap items-center justify-between gap-2 font-mono text-[11px]">
            <span className="text-foreground/85">{subtext}</span>
            {filesTotal > 0 && (
              <span className="tabular-telemetry tracking-[0.1em] text-muted-foreground uppercase">
                {indexingStage === "fetching" && `FILES ${filesProcessed}/${filesTotal}`}
                {indexingStage === "chunking" && `CHUNKS ${chunksProcessed}/${chunksTotal}`}
                {indexingStage === "embedding" && `VECTORS ${chunksProcessed}/${chunksTotal}`}
                {indexingStage === "saving" && `COMMIT ${chunksTotal} VECTORS`}
              </span>
            )}
          </div>
        </div>

        <p className="border-t border-border/70 pt-4 font-mono text-[10px] tracking-[0.14em] text-muted-foreground uppercase">
          COMMS CHANNEL UNLOCKS AUTOMATICALLY UPON SEQUENCE COMPLETION
        </p>
      </div>
    </div>
  );
}