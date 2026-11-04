"use client";

import { memo } from "react";
import { formatDistanceToNow } from "date-fns";
import { Plus, RotateCcw } from "lucide-react";

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

  return (
    <aside className="flex w-full flex-col border-b border-border bg-sidebar md:w-72 md:border-r md:border-b-0">
      <div className="space-y-3.5 p-4">
        <div className="space-y-1.5">
          <p className="font-mono text-[10px] tracking-[0.18em] text-muted-foreground uppercase">
            TARGET REPOSITORY
          </p>
          <p className="truncate font-heading text-sm font-semibold tracking-[0.06em]">
            {repo.fullName}
          </p>
          <div className="flex flex-wrap items-center gap-2 pt-0.5">
            <IndexStatusBadge status={repo.indexStatus} />
            {repo.chunkCount > 0 && (
              <span className="tabular-telemetry font-mono text-[10px] tracking-[0.1em] text-muted-foreground uppercase">
                {repo.chunkCount.toLocaleString()} VECTORS
              </span>
            )}
            {repo.isPrivate && (
              <span className="font-mono text-[10px] tracking-[0.12em] text-muted-foreground uppercase">
                PRIVATE
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
            New Channel
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

      <Separator />

      <div className="px-4 py-2.5 font-mono text-[10px] font-medium tracking-[0.18em] text-muted-foreground uppercase">
        Comms Logs
      </div>

      <ScrollArea className="flex-1">
        <div className="space-y-1 px-2 pb-4">
          {!ready && (
            <p className="px-2 font-mono text-[11px] text-muted-foreground">
              Channels unlock once indexing completes.
            </p>
          )}

          {sessionsQuery.isLoading &&
            Array.from({ length: 3 }).map((_, i) => (
              <Skeleton key={i} className="h-12 rounded-[2px]" />
            ))}

          {sessionsQuery.data?.map((session) => (
            <button
              key={session.id}
              type="button"
              onClick={() => onSelectSession(session.id)}
              className={cn(
                "w-full rounded-[2px] border-l-2 px-3 py-2.5 text-left transition-colors",
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
