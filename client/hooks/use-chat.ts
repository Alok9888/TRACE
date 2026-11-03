"use client";

import {
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { useCallback, useRef, useState } from "react";

import { api, type ChatMessage } from "@/lib/api";
import { queryKeys } from "@/lib/query-keys";
import { streamChatMessage } from "@/lib/stream-chat";
import { toast } from "@/components/ui/toast";

export function useChatSessions(repositoryId: string, enabled = true) {
  return useQuery({
    queryKey: queryKeys.chat.sessions(repositoryId),
    queryFn: () => api.listSessions(repositoryId),
    enabled: Boolean(repositoryId) && enabled,
  });
}

export function useChatMessages(sessionId: string | null) {
  return useQuery({
    queryKey: queryKeys.chat.messages(sessionId ?? ""),
    queryFn: () => api.getMessages(sessionId!),
    enabled: Boolean(sessionId),
  });
}

export function useCreateChatSession(repositoryId: string) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (title?: string) => api.createSession(repositoryId, title),
    onSuccess: (session) => {
      void queryClient.invalidateQueries({
        queryKey: queryKeys.chat.sessions(repositoryId),
      });
      queryClient.setQueryData(queryKeys.chat.messages(session.id), []);
    },
    onError: (error: Error) => {
      toast.add({
        title: "Could not create chat",
        description: error.message,
        type: "error",
      });
    },
  });
}

export function useStreamChat(sessionId: string | null) {
  const queryClient = useQueryClient();
  const [streaming, setStreaming] = useState(false);
  const [streamText, setStreamText] = useState("");
  const [streamError, setStreamError] = useState<{
    code?: string; message: string; triedModels?: string[]; retryAfter?: string;
  } | null>(null);
  const [lastContent, setLastContent] = useState("");
  const abortRef = useRef<AbortController | null>(null);

  // Batch high-frequency SSE tokens into at most one React state update per animation frame (60fps)
  const pendingTokensRef = useRef("");
  const rafIdRef = useRef<number | null>(null);

  const flushTokens = useCallback(() => {
    if (rafIdRef.current !== null) {
      cancelAnimationFrame(rafIdRef.current);
      rafIdRef.current = null;
    }
    if (pendingTokensRef.current) {
      const chunk = pendingTokensRef.current;
      pendingTokensRef.current = "";
      setStreamText((prev) => prev + chunk);
    }
  }, []);

  const clearPendingTokens = useCallback(() => {
    if (rafIdRef.current !== null) {
      cancelAnimationFrame(rafIdRef.current);
      rafIdRef.current = null;
    }
    pendingTokensRef.current = "";
  }, []);

  const send = useCallback(
    async (content: string) => {
      if (!sessionId || !content.trim() || streaming) return;

      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;

      const optimisticId = `temp-${Date.now()}`;
      const optimistic: ChatMessage = {
        id: optimisticId,
        role: "USER",
        content: content.trim(),
        citations: [],
        createdAt: new Date().toISOString(),
      };

      queryClient.setQueryData<ChatMessage[]>(
        queryKeys.chat.messages(sessionId),
        (prev) => [...(prev ?? []), optimistic]
      );

      clearPendingTokens();
      setStreaming(true);
      setStreamText("");
      setStreamError(null);
      setLastContent(content.trim());
      let responseModel: { model: string; fallback: boolean; provider?: string } | null = null;
      let serverReportedError = false;

      try {
        await streamChatMessage(sessionId, content.trim(), {
          signal: controller.signal,
          onUserMessage: (message) => {
            queryClient.setQueryData<ChatMessage[]>(
              queryKeys.chat.messages(sessionId),
              (prev) => [
                ...(prev ?? []).filter((m) => m.id !== optimisticId),
                message,
              ]
            );
          },
          onToken: (token) => {
            pendingTokensRef.current += token;
            if (rafIdRef.current === null) {
              rafIdRef.current = requestAnimationFrame(() => {
                rafIdRef.current = null;
                if (pendingTokensRef.current) {
                  const chunk = pendingTokensRef.current;
                  pendingTokensRef.current = "";
                  setStreamText((prev) => prev + chunk);
                }
              });
            }
          },
          onAssistantMessage: (message) => {
            clearPendingTokens();
            const enriched = responseModel ? Object.assign({}, message, { responseModel }) : message;
            queryClient.setQueryData<ChatMessage[]>(
              queryKeys.chat.messages(sessionId),
              (prev) => [...(prev ?? []), enriched]
            );
            setStreamText("");
          },
          onModel: (model, fallback, provider) => { responseModel = { model, fallback, provider }; },
          onError: (error) => {
            serverReportedError = true;
            clearPendingTokens();
            setStreaming(false);
            const structured = error as Error & { code?: string; triedModels?: string[]; retryAfter?: string };
            setStreamError({ code: structured.code, message: structured.message, triedModels: structured.triedModels, retryAfter: structured.retryAfter });
            setStreamText("");
          },
          onDone: () => {
            flushTokens();
            setStreaming(false);
          },
        });
      } catch (err) {
        if ((err as Error).name === "AbortError") return;
        if (!serverReportedError) {
          const message = err instanceof Error ? err.message : "Unknown error";
          setStreamError({ message });
          toast.add({ title: "Message failed", description: message, type: "error" });
        }
        clearPendingTokens();
        setStreamText("");
        setStreaming(false);
      }
    },
    [sessionId, streaming, queryClient, clearPendingTokens, flushTokens]
  );

  const retry = useCallback(() => { if (lastContent) void send(lastContent); }, [lastContent, send]);

  const stop = useCallback(() => {
    abortRef.current?.abort();
    clearPendingTokens();
    setStreaming(false);
  }, [clearPendingTokens]);

  return { send, stop, retry, streaming, streamText, streamError };
}
