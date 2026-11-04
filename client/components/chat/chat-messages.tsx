"use client";

import { memo, useEffect, useRef, useState } from "react";

import { ChatMarkdown } from "@/components/chat/chat-markdown";
import { CitationChips } from "@/components/chat/citation-chips";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Skeleton } from "@/components/ui/skeleton";
import type { ChatMessage, Repository } from "@/lib/api";

const LOADING_MESSAGES = [
  "QUERYING VECTOR SPACE...",
  "LOCATING SOURCE COORDINATES...",
  "READING RETRIEVED SEGMENTS...",
  "SYNTHESIZING RESPONSE...",
  "STREAMING TELEMETRY...",
];

const MessageRow = memo(function MessageRow({
  message,
  repo,
}: {
  message: ChatMessage;
  repo: Repository;
}) {
  const isUser = message.role === "USER";
  if (isUser) {
    return (
      <div className="flex flex-col items-end gap-1.5">
        <span className="font-mono text-[10px] tracking-[0.18em] text-muted-foreground uppercase">
          OPERATOR
        </span>
        <div className="max-w-[85%] rounded-[2px] border border-foreground/25 bg-foreground/[0.06] px-4 py-2.5 text-sm leading-relaxed text-foreground">
          <span className="whitespace-pre-wrap">{message.content}</span>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col items-start gap-2">
      <div className="flex items-center gap-2 font-mono text-[10px] tracking-[0.18em] text-muted-foreground uppercase">
        <span className="size-1.5 rounded-full bg-foreground/75" />
        <span>DEVPILOT // TELEMETRY</span>
      </div>
      <div className="w-full border-l border-border pl-4">
        <ChatMarkdown content={message.content} />
        {(message.citations?.length > 0 || message.responseModel?.fallback) && (
          <div className="mt-3 flex flex-col gap-2 border-t border-border/60 pt-2.5">
            {message.citations?.length > 0 && (
              <CitationChips repo={repo} citations={message.citations} />
            )}
            {message.responseModel?.fallback && (
              <span className="font-mono text-[10px] tracking-[0.1em] text-muted-foreground uppercase">
                FALLBACK // {message.responseModel.provider ?? "AI"} {message.responseModel.model}
              </span>
            )}
          </div>
        )}
      </div>
    </div>
  );
});

export function ChatMessages({
  repo,
  messages,
  streamText,
  isLoading,
  streaming,
  showLongWaitWarning,
  streamError,
  onRetry,
}: {
  repo: Repository;
  messages: ChatMessage[];
  streamText?: string;
  isLoading?: boolean;
  streaming?: boolean;
  showLongWaitWarning?: boolean;
  streamError?: { code?: string; message: string; triedModels?: string[]; retryAfter?: string } | null;
  onRetry?: () => void;
}) {
  const bottomRef = useRef<HTMLDivElement>(null);
  const [loadingMessageIndex, setLoadingMessageIndex] = useState(0);
  const [showLoading, setShowLoading] = useState(false);

  // Show loading messages when streaming but no tokens yet
  useEffect(() => {
    if (streaming && !streamText) {
      setShowLoading(true);
      const interval = setInterval(() => {
        setLoadingMessageIndex(prev => (prev + 1) % LOADING_MESSAGES.length);
      }, 2500);
      return () => clearInterval(interval);
    } else if (streamText) {
      setShowLoading(false);
    }
  }, [streaming, streamText]);

  useEffect(() => {
    // Use instant scroll during active token streaming to prevent smooth-scroll layout thrashing
    bottomRef.current?.scrollIntoView({ behavior: streaming ? "auto" : "smooth" });
  }, [messages, streamText, streaming]);

  if (isLoading) {
    return (
      <div className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-5 p-6">
        <Skeleton className="h-14 w-2/3 rounded-[2px]" />
        <Skeleton className="ml-auto h-10 w-1/2 rounded-[2px]" />
        <Skeleton className="h-24 w-3/4 rounded-[2px]" />
      </div>
    );
  }

  return (
    <ScrollArea className="flex-1">
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-7 px-5 py-8">
        {messages.length === 0 && !streamText && (
          <div className="border border-border bg-card/60 px-6 py-10">
            <p className="font-mono text-[10px] tracking-[0.2em] text-muted-foreground uppercase">
              COMMS CHANNEL OPEN // {repo.fullName}
            </p>
            <p className="mt-2 font-heading text-lg font-semibold tracking-[0.06em] uppercase">
              Ready for Codebase Interrogation
            </p>
            <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
              Query architecture, request lifecycles, or specific symbols. Example:
              &ldquo;Trace the indexing pipeline&rdquo; or &ldquo;Where is authentication enforced?&rdquo;
            </p>
          </div>
        )}

        <div className="flex flex-col gap-7">
          {messages.map((message) => (
            <MessageRow key={message.id} message={message} repo={repo} />
          ))}

          {/* Loading telemetry status before first token */}
          {showLoading && (
            <div className="flex flex-col items-start gap-2">
              <div className="flex items-center gap-2 font-mono text-[10px] tracking-[0.18em] text-muted-foreground uppercase">
                <span className="size-1.5 animate-pulse rounded-full bg-foreground" />
                <span>DEVPILOT // RECEIVING</span>
              </div>
              <div className="flex flex-wrap items-center gap-3 border-l border-foreground/40 pl-4 py-1 font-mono text-xs text-muted-foreground">
                <span>{LOADING_MESSAGES[loadingMessageIndex]}</span>
                {showLongWaitWarning && (
                  <span className="text-[11px] text-foreground/70">
                    EXTENDED RETRIEVAL IN PROGRESS...
                  </span>
                )}
              </div>
            </div>
          )}

          {streamText && (
            <div className="flex flex-col items-start gap-2">
              <div className="flex items-center gap-2 font-mono text-[10px] tracking-[0.18em] text-muted-foreground uppercase">
                <span className="size-1.5 animate-pulse rounded-full bg-foreground" />
                <span>DEVPILOT // STREAMING</span>
              </div>
              <div className="w-full border-l border-foreground/45 pl-4">
                <ChatMarkdown content={streamText} isStreaming />
                <span className="ml-1 inline-block h-3.5 w-1.5 animate-pulse bg-foreground align-middle" />
              </div>
            </div>
          )}
        </div>

        {streamError && (
          <div
            role="alert"
            className="border border-destructive/50 bg-destructive/10 p-4 text-xs"
          >
            <p className="font-mono text-[11px] font-semibold tracking-[0.14em] text-destructive uppercase">
              {streamError.code === "QUOTA_EXCEEDED"
                ? "FAULT // GROQ DAILY QUOTA EXCEEDED"
                : streamError.code === "MODEL_OVERLOADED"
                  ? "FAULT // PROVIDER OVERLOADED"
                  : "FAULT // GENERATION FAILED"}
            </p>
            <p className="mt-1.5 text-foreground/90">{streamError.message}</p>
            {streamError.code === "QUOTA_EXCEEDED" && (
              <p className="mt-1.5 font-mono text-[10px] text-muted-foreground">
                TRIED: {(streamError.triedModels ?? []).join(", ")}
                {streamError.retryAfter ? ` · RETRY IN ${streamError.retryAfter}` : ""}
              </p>
            )}
            {onRetry && (
              <button
                type="button"
                className="mt-3 rounded-[2px] border border-foreground/30 px-3 py-1.5 font-heading text-[11px] font-semibold tracking-[0.14em] uppercase transition-colors hover:border-foreground hover:bg-foreground hover:text-background"
                onClick={onRetry}
              >
                Retry Transmission
              </button>
            )}
          </div>
        )}
        <div ref={bottomRef} />
      </div>
    </ScrollArea>
  );
}