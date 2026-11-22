"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
import { getSourceTypeMeta } from "@/lib/api";
import {
  loadChatConfig,
  saveChatConfig,
  type ChatConfig,
} from "@/lib/chat-config";
import { warmUpStreamOrigin } from "@/lib/stream-chat";

export function ChatView({ repoId, initialUrl }: { repoId: string; initialUrl?: string }) {
  // Pre-warm DNS/TCP/TLS to the direct streaming origin before the user sends their first prompt
  useEffect(() => {
    warmUpStreamOrigin();
  }, []);
  const routeRepoId = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(repoId)
    ? repoId
    : null;

  // Use URL-based status polling when we have initialUrl but no route UUID yet
  const urlStatusQuery = useIndexStatusByUrl(initialUrl ?? "", Boolean(initialUrl && !routeRepoId));
  const effectiveRepoId = routeRepoId ?? urlStatusQuery.data?.repositoryId ?? "";
  const shouldFetchRepo = Boolean(effectiveRepoId);

  // Single-poller strategy: useRepository fetches repo details once (no duplicate 500ms poll),
  // and useIndexStatus polls only while indexing is NOT already READY.
  const repoQuery = useRepository(effectiveRepoId, {
    enabled: shouldFetchRepo,
    pollWhileIndexing: false,
  });

  // Only poll /status when repo isn't already known to be READY (avoids wasted DB call on ready repos)
  const shouldPollStatus = Boolean(effectiveRepoId) && repoQuery.data?.indexStatus !== "READY";
  const repoStatusQuery = useIndexStatus(effectiveRepoId, shouldPollStatus);

  // Preserve last known status across the handoff from URL polling to repoId polling so UI never flashes back to "creating"
  const latestStatus = repoStatusQuery.data ?? urlStatusQuery.data;

  const statusIndex = latestStatus?.indexStatus;
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

  const [chatConfig, setChatConfig] = useState<ChatConfig>(() => loadChatConfig());
  const chatConfigRef = useRef<ChatConfig>(chatConfig);
  const handleConfigChange = useCallback((next: ChatConfig) => {
    chatConfigRef.current = next;
    setChatConfig(next);
    saveChatConfig(next);
  }, []);

  const messagesQuery = useChatMessages(sessionId);
  const { send, stop, retry, streaming, streamText, streamError } = useStreamChat(
    sessionId,
    chatConfigRef
  );

  // Track when streaming started for the 10s warning
  const [longWaitElapsed, setLongWaitElapsed] = useState(false);
  const showLongWaitWarning = Boolean(streaming && longWaitElapsed);

  useEffect(() => {
    if (!streaming) return;
    const resetTimer = window.setTimeout(() => setLongWaitElapsed(false), 0);
    const warnTimer = window.setTimeout(() => setLongWaitElapsed(true), 10000);
    return () => {
      window.clearTimeout(resetTimer);
      window.clearTimeout(warnTimer);
    };
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
      filesProcessed: latestStatus?.filesProcessed ?? repo.filesProcessed,
      filesTotal: latestStatus?.filesTotal ?? repo.filesTotal,
      chunkCount: latestStatus?.chunkCount ?? repo.chunkCount,
      errorMessage: latestStatus?.errorMessage ?? repo.errorMessage,
    };
  }, [
    repo,
    indexStatus,
    latestStatus?.filesProcessed,
    latestStatus?.filesTotal,
    latestStatus?.chunkCount,
    latestStatus?.errorMessage,
  ]);

  // Calculate values based on stage for proper progress
  const urlStatus = latestStatus;

  // Calculate files/total for progress based on source
  const filesTotal = urlStatus?.filesTotal ?? repo?.filesTotal ?? 0;
  const filesProcessed = urlStatus?.filesProcessed ?? repo?.filesProcessed ?? 0;
  const chunksTotal = urlStatus?.chunksTotal ?? repo?.chunkCount ?? 0;
  const chunksProcessed = urlStatus?.chunksProcessed ?? 0;
  const currentStage: 'creating' | 'fetching' | 'chunking' | 'embedding' | 'saving' | 'done' | null =
    urlStatus?.indexingStage ?? (repo?.indexStatus === 'INDEXING' ? 'fetching' : 'creating');
  const indexingDetail = urlStatus?.indexingDetail ?? 'Initializing source...';

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
      fullName: 'Source',
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
      <AppShell title="Indexing source…" description={indexingDetail ?? 'Starting indexing...'}>
        <IndexingState repo={tempRepo} status={tempStatus} />
      </AppShell>
    );
  }

  // Show error only if we have a real repo query error
  if (repoQuery.isError) {
    return (
      <AppShell title="Source unavailable">
        <div className="flex flex-1 flex-col items-center justify-center gap-3 p-8">
          <p className="text-sm text-muted-foreground">
            {(repoQuery.error as Error)?.message ?? "Source not found"}
          </p>
          <Button render={<Link href="/dashboard" />}>Back to Console</Button>
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

  const typeMeta = getSourceTypeMeta(repo.sourceType);

  return (
    <AppShell
      title={repo.fullName}
      description={
        ready
          ? repo.chunkCount > 0
            ? `${typeMeta.badge} // COMMS ONLINE // ${repo.chunkCount.toLocaleString()} VECTORS INDEXED`
            : `${typeMeta.badge} // COMMS ONLINE // GROUNDED IN INDEXED CONTEXT`
          : `${typeMeta.badge} // INGESTION SEQUENCE IN PROGRESS`
      }
      actions={
        <Button variant="outline" size="sm" render={<Link href="/dashboard" />}>
          <ArrowLeft data-icon="inline-start" />
          Console
        </Button>
      }
    >
      <div className="flex h-[calc(100svh-3.25rem)] max-h-[calc(100svh-3.25rem)] min-h-0 flex-col overflow-hidden md:h-[calc(100svh-4.25rem)] md:max-h-[calc(100svh-4.25rem)] md:flex-row">
        <ChatSidebar
          repo={sidebarRepo}
          sessionId={sessionId}
          onSelectSession={setSelectedSessionId}
          config={chatConfig}
          onConfigChange={handleConfigChange}
        />

        <section className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
          {!ready ? (
            <IndexingState repo={repo} status={latestStatus} />
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
                sourceType={repo.sourceType}
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
