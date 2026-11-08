"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft } from "lucide-react";

import { ChatComposer } from "@/components/chat/chat-composer";
import { ChatMessages } from "@/components/chat/chat-messages";
import { ChatSidebar } from "@/components/chat/chat-sidebar";
import { IndexingState } from "@/components/chat/indexing-state";
import { AppShell } from "@/components/layout/app-shell";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  useChatMessages,
  useChatSessions,
  useCreateChatSession,
  useStreamChat,
} from "@/hooks/use-chat";
import { useIndexStatus, useIndexStatusByUrl, useRepository } from "@/hooks/use-repos";

export function ChatView({ repoId, initialUrl }: { repoId: string; initialUrl?: string }) {
  const [resolvedRepoId, setResolvedRepoId] = useState<string | null>(null);

  const routeRepoId = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(repoId)
    ? repoId
    : null;
  const effectiveRepoId = resolvedRepoId ?? routeRepoId ?? "";
  const shouldFetchRepo = Boolean(effectiveRepoId);

  // Single-poller strategy: useRepository fetches repo details once (no duplicate 500ms poll),
  // and useIndexStatus polls only while indexing is NOT already READY.
  const repoQuery = useRepository(effectiveRepoId, {
    enabled: shouldFetchRepo,
    pollWhileIndexing: false,
  });

  // Use URL-based status polling when we have initialUrl but no repo ID yet
  const urlStatusQuery = useIndexStatusByUrl(initialUrl ?? "", Boolean(initialUrl && !effectiveRepoId));
  // Only poll /status when repo isn't already known to be READY (avoids wasted DB call on ready repos)
  const shouldPollStatus = Boolean(effectiveRepoId) && repoQuery.data?.indexStatus !== "READY";
  const repoStatusQuery = useIndexStatus(effectiveRepoId, shouldPollStatus);

  // Choose which status to use
  const statusQuery = initialUrl && !effectiveRepoId ? urlStatusQuery : repoStatusQuery;
  useEffect(() => {
    if (urlStatusQuery.data?.repositoryId) {
      setResolvedRepoId(urlStatusQuery.data.repositoryId);
    }
  }, [urlStatusQuery.data?.repositoryId]);

  const statusIndex = statusQuery.data?.indexStatus;
  const repositoryIndex = repoQuery.data?.indexStatus;
  const indexStatus = statusIndex === "READY" || repositoryIndex === "READY"
    ? "READY"
    : statusIndex ?? repositoryIndex;
  const ready = indexStatus === "READY";

  // When status polling finishes (READY/FAILED) — e.g. while user was in another tab — sync repo detail immediately
  useEffect(() => {
    if (!effectiveRepoId) return;
    if (
      (statusIndex === "READY" || statusIndex === "FAILED") &&
      (!repoQuery.data || repoQuery.data.indexStatus !== statusIndex) &&
      !repoQuery.isFetching &&
      !repoQuery.isError
    ) {
      void repoQuery.refetch();
    }
  }, [effectiveRepoId, statusIndex, repoQuery]);

  // Fetch chat sessions in parallel with repo detail as soon as effectiveRepoId is known (breaks serial waterfall)
  const sessionsQuery = useChatSessions(effectiveRepoId, Boolean(effectiveRepoId));
  const createSession = useCreateChatSession(effectiveRepoId);
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(
    null
  );
  const autoCreateRef = useRef(false);

  const sessionId =
    selectedSessionId ?? sessionsQuery.data?.[0]?.id ?? null;

  const messagesQuery = useChatMessages(sessionId);
  const { send, stop, retry, streaming, streamText, streamError } = useStreamChat(sessionId);

  // Track when streaming started for the 10s warning
  const [showLongWaitWarning, setShowLongWaitWarning] = useState(false);

  useEffect(() => {
    if (streaming) {
      const timer = setTimeout(() => {
        setShowLongWaitWarning(true);
      }, 10000);
      return () => clearTimeout(timer);
    }
    setShowLongWaitWarning(false);
  }, [streaming]);

  useEffect(() => {
    if (!ready || sessionsQuery.isLoading) return;
    if (sessionsQuery.data && sessionsQuery.data.length > 0) return;
    if (
      !sessionsQuery.isSuccess ||
      (sessionsQuery.data?.length ?? 0) > 0 ||
      autoCreateRef.current
    ) {
      return;
    }

    autoCreateRef.current = true;
    createSession.mutate(undefined, {
      onSuccess: (session) => setSelectedSessionId(session.id),
      onError: () => {
        autoCreateRef.current = false;
      },
    });
  }, [
    ready,
    sessionsQuery.isLoading,
    sessionsQuery.isSuccess,
    sessionsQuery.data,
    createSession,
  ]);

  const repo = repoQuery.data;

  // Must remain BEFORE any early returns to satisfy React Rules of Hooks!
  // Stabilizes merged repo prop so 60fps streaming updates never re-render memoized ChatSidebar.
  const sidebarRepo = useMemo(() => {
    if (!repo) return null;
    return {
      ...repo,
      indexStatus: indexStatus ?? repo.indexStatus,
      filesProcessed: statusQuery.data?.filesProcessed ?? repo.filesProcessed,
      filesTotal: statusQuery.data?.filesTotal ?? repo.filesTotal,
      chunkCount: statusQuery.data?.chunkCount ?? repo.chunkCount,
      errorMessage: statusQuery.data?.errorMessage ?? repo.errorMessage,
    };
  }, [
    repo,
    indexStatus,
    statusQuery.data?.filesProcessed,
    statusQuery.data?.filesTotal,
    statusQuery.data?.chunkCount,
    statusQuery.data?.errorMessage,
  ]);

  // Calculate values based on stage for proper progress
  const urlStatus = statusQuery.data;

  // Calculate files/total for progress based on source
  const filesTotal = urlStatus?.filesTotal ?? repo?.filesTotal ?? 0;
  const filesProcessed = urlStatus?.filesProcessed ?? repo?.filesProcessed ?? 0;
  const chunksTotal = urlStatus?.chunksTotal ?? repo?.chunkCount ?? 0;
  const chunksProcessed = urlStatus?.chunksProcessed ?? 0;
  const currentStage: 'creating' | 'fetching' | 'chunking' | 'embedding' | 'saving' | 'done' | null =
    urlStatus?.indexingStage ?? (repo?.indexStatus === 'INDEXING' ? 'fetching' : 'creating');
  const indexingDetail = urlStatus?.indexingDetail ?? 'Creating repo row...';

  // CRITICAL: Keep showing indexing overlay whenever we don't have `repo` yet (and haven't errored)
  // while `initialUrl` or live status exists — prevents flashing/sticking on "Loading chat..."
  // when repoId resolves or user switches back from another tab.
  if (!repo && !repoQuery.isError && (initialUrl || (urlStatus && urlStatus.indexStatus !== "READY"))) {
    const tempStatus = {
      repositoryId: effectiveRepoId || 'temp',
      indexStatus: urlStatus?.indexStatus ?? ('INDEXING' as const),
      filesTotal,
      filesProcessed,
      chunkCount: urlStatus?.chunkCount ?? chunksTotal,
      chunksTotal,
      chunksProcessed,
      indexingStage: currentStage,
      indexingDetail,
      indexedAt: urlStatus?.indexedAt ?? null,
      errorMessage: urlStatus?.errorMessage ?? null,
    };
    const tempRepo = {
      id: effectiveRepoId || 'temp',
      githubRepoId: 0,
      owner: '',
      name: '',
      fullName: 'Repository',
      isPrivate: false,
      defaultBranch: 'main',
      language: null,
      htmlUrl: null,
      description: null,
      indexStatus: tempStatus.indexStatus,
      indexedAt: tempStatus.indexedAt,
      chunkCount: tempStatus.chunkCount,
      filesTotal,
      filesProcessed,
      errorMessage: tempStatus.errorMessage,
    };
    return (
      <AppShell title="Indexing repository…" description={indexingDetail ?? 'Starting indexing...'}>
        <IndexingState repo={tempRepo} status={tempStatus} />
      </AppShell>
    );
  }

  // Show error only if we have a real repo query error
  if (repoQuery.isError) {
    return (
      <AppShell title="Repository unavailable">
        <div className="flex flex-1 flex-col items-center justify-center gap-3 p-8">
          <p className="text-sm text-muted-foreground">
            {(repoQuery.error as Error)?.message ?? "Repository not found"}
          </p>
          <Button render={<Link href="/dashboard" />}>Back to dashboard</Button>
        </div>
      </AppShell>
    );
  }

  // Only show "Loading chat..." when !repo && !initialUrl (direct visit to /chat/<uuid>)
  if (!repo || !sidebarRepo) {
    return (
      <AppShell title="Initializing Console...">
        <div className="grid flex-1 gap-4 p-4 md:grid-cols-[18rem_1fr]">
          <Skeleton className="min-h-80 rounded-[2px]" />
          <Skeleton className="min-h-80 rounded-[2px]" />
        </div>
      </AppShell>
    );
  }

  return (
    <AppShell
      title={repo.fullName}
      description={
        ready
          ? repo.chunkCount > 0
            ? `${repo.chunkCount.toLocaleString()} indexed chunks`
            : "Ready"
          : "Indexing repository"
      }
      actions={
        <Button variant="outline" size="sm" render={<Link href="/dashboard" />}>
          <ArrowLeft data-icon="inline-start" />
          Repos
        </Button>
      }
    >
      <div className="flex h-[calc(100svh-3.25rem)] min-h-0 flex-1 flex-col overflow-hidden md:flex-row">
        <ChatSidebar
          repo={sidebarRepo}
          sessionId={sessionId}
          onSelectSession={setSelectedSessionId}
        />

        <section className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
          {!ready ? (
            <IndexingState repo={repo} status={statusQuery.data} />
          ) : (
            <>
              <ChatMessages
                repo={repo}
                messages={messagesQuery.data ?? []}
                streamText={streamText}
                isLoading={messagesQuery.isLoading}
                streaming={streaming}
                showLongWaitWarning={showLongWaitWarning}
                streamError={streamError}
                onRetry={retry}
                onSelectPrompt={sessionId ? send : undefined}
              />
              <ChatComposer
                disabled={!sessionId}
                streaming={streaming}
                onSend={send}
                onStop={stop}
              />
            </>
          )}
        </section>
      </div>
    </AppShell>
  );
}
