"use client";

import { memo, useState } from "react";
import { formatDistanceToNow } from "date-fns";
import { ChevronDown, Plus, RotateCcw } from "lucide-react";

import { IndexStatusBadge } from "@/components/dashboard/repo-status";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import {
  useChatSessions,
  useCreateChatSession,
} from "@/hooks/use-chat";
import { useStartIndexing } from "@/hooks/use-repos";
import type { Repository } from "@/lib/api";
import { cn } from "@/lib/utils";

export const ChatSidebar = memo(function ChatSidebar({
  repo,
  sessionId,
  onSelectSession,
}: {
  repo: Repository;
  sessionId: string | null;
  onSelectSession: (id: string) => void;
}) {
  const ready = repo.indexStatus === "READY";
  const sessionsQuery = useChatSessions(repo.id, ready);
  const createSession = useCreateChatSession(repo.id);
  const reindex = useStartIndexing();
  const [mobileLogsOpen, setMobileLogsOpen] = useState(false);

  const activeSession = sessionsQuery.data?.find((s) => s.id === sessionId);

  return (
    <aside className="sticky top-13 z-10 flex w-full shrink-0 flex-col border-b border-border bg-sidebar md:h-full md:w-72 md:overflow-hidden md:border-r md:border-b-0">
      {/* Compact mobile bar (< md) so chat gets the full viewport height */}
      <div className="flex items-center justify-between gap-2 px-3 py-2 md:hidden">
        <button
          type="button"
          onClick={() => setMobileLogsOpen((prev) => !prev)}
          className="flex min-w-0 flex-1 items-center gap-2 text-left"
        >
          <IndexStatusBadge status={repo.indexStatus} />
          <span className="truncate font-mono text-[11px] tracking-[0.06em] text-foreground">
            {activeSession?.title ?? repo.name}
          </span>
          <ChevronDown
            className={cn(
              "size-3.5 shrink-0 text-muted-foreground transition-transform",
              mobileLogsOpen && "rotate-180"
            )}
          />
        </button>

        <div className="flex shrink-0 items-center gap-1.5">
          <Button
            size="xs"
            disabled={!ready || createSession.isPending}
            onClick={() =>
              createSession.mutate("New chat", {
                onSuccess: (session) => {
                  onSelectSession(session.id);
                  setMobileLogsOpen(false);
                },
              })
            }
          >
            <Plus className="size-3" />
            New
          </Button>
          <Button
            size="icon-xs"
            variant="outline"
            disabled={reindex.isPending || repo.indexStatus === "INDEXING"}
            onClick={() => reindex.mutate(repo.id)}
            aria-label="Re-index repository"
          >
            <RotateCcw className="size-3" />
          </Button>
        </div>
      </div>

      {/* Desktop repository header */}
      <div className="hidden space-y-3.5 p-4 md:block">
        <div className="space-y-1.5">
          <p className="font-mono text-[10px] tracking-[0.16em] text-muted-foreground uppercase">
            Repository
          </p>
          <p className="truncate font-heading text-sm font-semibold tracking-[0.04em]">
            {repo.fullName}
          </p>
          <div className="flex flex-wrap items-center gap-2 pt-0.5">
            <IndexStatusBadge status={repo.indexStatus} />
            {repo.chunkCount > 0 && (
              <span className="tabular-telemetry font-mono text-[10px] tracking-[0.08em] text-muted-foreground uppercase">
                {repo.chunkCount.toLocaleString()} chunks
              </span>
            )}
            {repo.isPrivate && (
              <span className="font-mono text-[10px] tracking-[0.1em] text-muted-foreground uppercase">
                Private
              </span>
            )}
          </div>
        </div>

        <div className="flex gap-2">
          <Button
            size="sm"
            className="flex-1"
            disabled={!ready || createSession.isPending}
            onClick={() =>
              createSession.mutate("New chat", {
                onSuccess: (session) => onSelectSession(session.id),
              })
            }
          >
            <Plus data-icon="inline-start" />
            New Chat
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={reindex.isPending || repo.indexStatus === "INDEXING"}
            onClick={() => reindex.mutate(repo.id)}
            aria-label="Re-index repository"
          >
            <RotateCcw className="size-3.5" />
          </Button>
        </div>
      </div>

      <Separator className={cn(!mobileLogsOpen && "hidden md:block")} />

      <div
        className={cn(
          "px-4 py-2 font-mono text-[10px] font-medium tracking-[0.16em] text-muted-foreground uppercase",
          !mobileLogsOpen && "hidden md:block"
        )}
      >
        Sessions {sessionsQuery.data ? `(${sessionsQuery.data.length})` : ""}
      </div>

      <ScrollArea
        className={cn(
          "min-h-0 max-h-52 overflow-hidden border-t border-border/60 md:max-h-none md:flex-1 md:border-t-0",
          !mobileLogsOpen && "hidden md:block"
        )}
      >
        <div className="space-y-1 px-2 py-2 md:py-0 md:pb-4">
          {!ready && (
            <p className="px-2 font-mono text-[11px] text-muted-foreground">
              Channels unlock once indexing completes.
            </p>
          )}

          {sessionsQuery.isLoading &&
            Array.from({ length: 3 }).map((_, i) => (
              <Skeleton key={i} className="h-11 rounded-[2px]" />
            ))}

          {sessionsQuery.data?.map((session) => (
            <button
              key={session.id}
              type="button"
              onClick={() => {
                onSelectSession(session.id);
                setMobileLogsOpen(false);
              }}
              className={cn(
                "w-full rounded-[2px] border-l-2 px-3 py-2 text-left transition-colors md:py-2.5",
                sessionId === session.id
                  ? "border-l-foreground bg-accent text-foreground"
                  : "border-l-transparent text-muted-foreground hover:bg-accent/50 hover:text-foreground"
              )}
            >
              <p className="truncate text-xs font-medium">{session.title}</p>
              <p className="mt-0.5 font-mono text-[10px] tracking-[0.06em] text-muted-foreground uppercase">
                {formatDistanceToNow(new Date(session.createdAt), {
                  addSuffix: true,
                })}
              </p>
            </button>
          ))}

          {ready && sessionsQuery.isSuccess && sessionsQuery.data.length === 0 && (
            <p className="px-2 font-mono text-[11px] text-muted-foreground">
              No active logs. Open a channel to begin.
            </p>
          )}
        </div>
      </ScrollArea>
    </aside>
  );
});
