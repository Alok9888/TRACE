"use client";

import { useCallback, type PointerEvent as ReactPointerEvent } from "react";
import { useRouter } from "next/navigation";
import { useQueryClient } from "@tanstack/react-query";
import {
  ArrowRight,
  ExternalLink,
  GitBranch,
  Lock,
  MessageSquare,
  RotateCcw,
  Sparkles,
} from "lucide-react";

import { IndexErrorAlert } from "@/components/dashboard/index-error-alert";
import { LanguageBadge } from "@/components/dashboard/language-badge";
import { IndexStatusBadge } from "@/components/dashboard/repo-status";
import { LanguageIcon } from "@/components/icons/language-icon";
import { SourceTypeIcon } from "@/components/icons/source-type-icon";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { Spinner } from "@/components/ui/spinner";
import { getRepoProgress, useStartIndexing } from "@/hooks/use-repos";
import {
  api,
  formatFileSize,
  getSourceTypeMeta,
  isUploadedSource,
  type Repository,
} from "@/lib/api";
import { queryKeys } from "@/lib/query-keys";
import { cn } from "@/lib/utils";

export function RepoCard({ repo }: { repo: Repository }) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const indexMutation = useStartIndexing();
  const uploaded = isUploadedSource(repo);
  const typeMeta = getSourceTypeMeta(repo.sourceType);
  const isIndexing =
    repo.indexStatus === "INDEXING" || indexMutation.isPending;
  const isFailed = repo.indexStatus === "FAILED";
  const progress = getRepoProgress(repo);

  const prefetchChat = useCallback(() => {
    if (repo.indexStatus !== "READY") return;
    router.prefetch(`/chat/${repo.id}`);
    queryClient.setQueryData(queryKeys.repos.detail(repo.id), repo);
    void queryClient.prefetchQuery({
      queryKey: queryKeys.chat.sessions(repo.id),
      queryFn: () => api.listSessions(repo.id),
      staleTime: 30_000,
    });
  }, [queryClient, repo, router]);

  function openChat() {
    router.push(`/chat/${repo.id}`);
  }

  function handlePrimary() {
    if (repo.indexStatus === "READY" || uploaded) {
      openChat();
      return;
    }

    indexMutation.mutate(repo.id, {
      onSuccess: () => router.push(`/chat/${repo.id}`),
    });
  }

  function handlePointerMove(e: ReactPointerEvent<HTMLElement>) {
    const rect = e.currentTarget.getBoundingClientRect();
    e.currentTarget.style.setProperty("--mx", `${e.clientX - rect.left}px`);
    e.currentTarget.style.setProperty("--my", `${e.clientY - rect.top}px`);
  }

  return (
    <article
      onMouseEnter={prefetchChat}
      onPointerMove={handlePointerMove}
      className={cn(
        "spotlight-card group flex flex-col overflow-hidden rounded-[2px] border bg-card/90",
        isFailed
          ? "border-destructive/40 hover:border-destructive/70"
          : "border-border hover:border-foreground/45"
      )}
    >
      <div className="border-b border-border/80 px-4 py-3.5">
        <div className="flex items-start justify-between gap-3">
          <div className="flex min-w-0 items-start gap-3">
            {uploaded ? (
              <div className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-[2px] border border-border bg-background/80 text-foreground/85">
                <SourceTypeIcon sourceType={repo.sourceType} className="size-3.5" />
              </div>
            ) : (
              <div className="mt-0.5 opacity-80 grayscale">
                <LanguageBadge language={repo.language} showLabel={false} />
              </div>
            )}
            <div className="min-w-0">
              <p className="truncate font-mono text-[10px] tracking-[0.14em] text-muted-foreground uppercase">
                {uploaded ? typeMeta.label : repo.owner}
              </p>
              <h3 className="truncate font-heading text-base font-semibold tracking-[0.04em]">
                {repo.name}
              </h3>
            </div>
          </div>
          <IndexStatusBadge status={repo.indexStatus} />
        </div>
      </div>

      <div className="flex flex-1 flex-col gap-4 p-4">
        {!isFailed && (
          <p className="line-clamp-2 min-h-10 text-xs leading-relaxed text-muted-foreground">
            {repo.description ||
              (uploaded
                ? `Indexed ${typeMeta.label.toLowerCase()} ready for grounded queries.`
                : "No source specification provided.")}
          </p>
        )}

        {isFailed && repo.description && (
          <p className="line-clamp-1 text-xs text-muted-foreground">
            {repo.description}
          </p>
        )}

        <div className="flex flex-wrap items-center gap-1.5 font-mono text-[10px] tracking-[0.08em] text-muted-foreground uppercase">
          {uploaded ? (
            <>
              <span className="inline-flex items-center gap-1 rounded-[2px] border border-border px-2 py-0.5 text-foreground/85">
                <SourceTypeIcon sourceType={repo.sourceType} className="size-2.5" />
                {typeMeta.badge}
              </span>
              {repo.pageCount != null && repo.pageCount > 0 && (
                <span className="tabular-telemetry rounded-[2px] border border-border px-2 py-0.5">
                  {repo.pageCount}{" "}
                  {repo.pageCount === 1 ? typeMeta.unitSingular : typeMeta.unitPlural}
                </span>
              )}
              {repo.fileSizeBytes != null && repo.fileSizeBytes > 0 && (
                <span className="tabular-telemetry rounded-[2px] border border-border px-2 py-0.5">
                  {formatFileSize(repo.fileSizeBytes)}
                </span>
              )}
            </>
          ) : (
            <>
              {repo.isPrivate && (
                <span className="inline-flex items-center gap-1 rounded-[2px] border border-border px-2 py-0.5">
                  <Lock className="size-2.5" />
                  Private
                </span>
              )}

              <span className="inline-flex items-center gap-1 rounded-[2px] border border-border px-2 py-0.5">
                <GitBranch className="size-2.5" />
                {repo.defaultBranch}
              </span>

              {repo.language && (
                <span className="inline-flex items-center gap-1.5 rounded-[2px] border border-border px-2 py-0.5 text-foreground/85">
                  <span className="grayscale">
                    <LanguageIcon language={repo.language} size="sm" />
                  </span>
                  {repo.language}
                </span>
              )}
            </>
          )}

          {repo.chunkCount > 0 && (
            <span
              className={cn(
                "tabular-telemetry rounded-[2px] border px-2 py-0.5",
                isFailed
                  ? "border-destructive/30 text-destructive/80"
                  : "border-border text-muted-foreground"
              )}
            >
              {repo.chunkCount.toLocaleString()} chunks
            </span>
          )}
        </div>

        {isIndexing && (
          <div className="space-y-2 border border-border bg-background/60 p-3">
            <div className="tabular-telemetry flex items-center justify-between font-mono text-[10px] tracking-[0.14em] text-muted-foreground uppercase">
              <span>Syncing</span>
              <span>
                {repo.filesProcessed}/{repo.filesTotal || "--"}
              </span>
            </div>
            <Progress value={progress || 8} className="h-[2px] rounded-none" />
          </div>
        )}

        {isFailed && repo.errorMessage && (
          <IndexErrorAlert message={repo.errorMessage} />
        )}
      </div>

      <div className="mt-auto flex items-center justify-between gap-2 border-t border-border/80 bg-background/40 px-4 py-3">
        {!uploaded && repo.htmlUrl ? (
          <Button
            nativeButton={false}
            variant="ghost"
            size="sm"
            render={
              <a
                href={repo.htmlUrl}
                target="_blank"
                rel="noreferrer"
              />
            }
          >
            <ExternalLink data-icon="inline-start" />
            Origin
          </Button>
        ) : (
          <span className="font-mono text-[10px] tracking-[0.12em] text-muted-foreground/75 uppercase">
            {uploaded ? "UPLOADED" : ""}
          </span>
        )}

        <div className="flex gap-2">
          {repo.indexStatus === "READY" && (
            <Button variant="outline" size="sm" onClick={openChat}>
              <MessageSquare data-icon="inline-start" />
              Comms
            </Button>
          )}

          {!(uploaded && isFailed) && (
            <Button
              size="sm"
              variant={isFailed ? "outline" : "default"}
              className={cn(
                isFailed &&
                  "border-destructive/40 text-destructive hover:border-destructive hover:bg-destructive hover:text-white"
              )}
              disabled={isIndexing}
              onClick={handlePrimary}
            >
              {isIndexing ? (
                <>
                  <Spinner data-icon="inline-start" />
                  Syncing
                </>
              ) : repo.indexStatus === "READY" ? (
                <>
                  Open
                  <ArrowRight data-icon="inline-end" />
                </>
              ) : isFailed ? (
                <>
                  <RotateCcw data-icon="inline-start" />
                  Retry
                </>
              ) : (
                <>
                  <Sparkles data-icon="inline-start" />
                  Index
                </>
              )}
            </Button>
          )}
        </div>
      </div>
    </article>
  );
}
