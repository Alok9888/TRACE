"use client";

import { memo, useEffect, useRef, useState } from "react";
import { ArrowUpRight, Check, Copy } from "lucide-react";

import { ChatMarkdown } from "@/components/chat/chat-markdown";
import { CitationChips } from "@/components/chat/citation-chips";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Skeleton } from "@/components/ui/skeleton";
import { isPdfSource, type ChatMessage, type Repository } from "@/lib/api";

const LOADING_MESSAGES = [
  "QUERYING VECTOR SPACE...",
  "LOCATING SOURCE COORDINATES...",
  "READING RETRIEVED SEGMENTS...",
  "SYNTHESIZING RESPONSE...",
  "STREAMING TELEMETRY...",
];

const REPO_STARTER_PROMPTS = [
  "Map the system architecture and core module boundaries.",
  "Locate the entry point and trace the startup sequence.",
  "Trace the primary request lifecycle end to end.",
];

const PDF_STARTER_PROMPTS = [
  "Summarize the core thesis and key takeaways with page citations.",
  "List the major sections, findings, or recommendations in this document.",
  "Identify critical metrics, dates, or definitions referenced in the text.",
];

const MessageRow = memo(function MessageRow({
  message,
  repo,
}: {
  message: ChatMessage;
  repo: Repository;
}) {
  const [copied, setCopied] = useState(false);
  const isUser = message.role === "USER";

  function handleCopy() {
    void navigator.clipboard.writeText(message.content).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    });
  }

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
    <div className="group flex flex-col items-start gap-2">
      <div className="flex w-full items-center justify-between gap-2">
        <div className="flex items-center gap-2 font-mono text-[10px] tracking-[0.18em] text-muted-foreground uppercase">
          <span className="size-1.5 rounded-full bg-foreground/75" />
          <span>TRACE // TELEMETRY</span>
        </div>
        <button
          type="button"
          onClick={handleCopy}
          aria-label="Copy response"
          className="inline-flex items-center gap-1 font-mono text-[10px] tracking-[0.1em] text-muted-foreground uppercase opacity-100 transition-opacity hover:text-foreground sm:opacity-0 sm:group-hover:opacity-100"
        >
          {copied ? <Check className="size-3" /> : <Copy className="size-3" />}
          <span>{copied ? "Copied" : "Copy"}</span>
        </button>
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
  onSelectPrompt,
}: {
  repo: Repository;
  messages: ChatMessage[];
  streamText?: string;
  isLoading?: boolean;
  streaming?: boolean;
  showLongWaitWarning?: boolean;
  streamError?: { code?: string; message: string; triedModels?: string[]; retryAfter?: string } | null;
  onRetry?: () => void;
  onSelectPrompt?: (prompt: string) => void;
}) {
  const bottomRef = useRef<HTMLDivElement>(null);
  const [loadingMessageIndex, setLoadingMessageIndex] = useState(0);
  const showLoading = Boolean(streaming && !streamText);

  // Rotate loading telemetry messages while waiting for first token
  useEffect(() => {
    if (!showLoading) return;
    const interval = setInterval(() => {
      setLoadingMessageIndex((prev) => (prev + 1) % LOADING_MESSAGES.length);
    }, 2500);
    return () => clearInterval(interval);
  }, [showLoading]);

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
    <ScrollArea className="min-h-0 flex-1 overflow-hidden">
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-4 py-6 sm:gap-7 sm:px-5 sm:py-8">
        {messages.length === 0 && !streamText && (() => {
          const isPdf = isPdfSource(repo);
          const starterPrompts = isPdf ? PDF_STARTER_PROMPTS : REPO_STARTER_PROMPTS;
          return (
            <div className="space-y-5 border border-border bg-card/60 p-5 sm:p-7">
              <div className="space-y-1.5">
                <p className="font-mono text-[10px] tracking-[0.2em] text-muted-foreground uppercase">
                  COMMS CHANNEL OPEN // {repo.fullName}
                </p>
                <p className="font-heading text-lg font-semibold tracking-[0.06em] uppercase">
                  Ready for Interrogation
                </p>
                <p className="text-xs leading-relaxed text-muted-foreground">
                  {isPdf
                    ? "Query sections, arguments, or specific details. Responses are grounded directly in retrieved document pages."
                    : "Query architecture, execution paths, or symbols. Responses are grounded directly in retrieved source lines."}
                </p>
              </div>
              {onSelectPrompt && (
                <div className="divide-y divide-border/70 border border-border/80">
                  {starterPrompts.map((prompt) => (
                    <button
                      key={prompt}
                      type="button"
                      onClick={() => onSelectPrompt(prompt)}
                      className="group flex w-full items-center justify-between gap-3 px-3.5 py-2.5 text-left text-xs text-muted-foreground transition-colors hover:bg-foreground/[0.04] hover:text-foreground"
                    >
                      <span>{prompt}</span>
                      <ArrowUpRight className="size-3.5 shrink-0 opacity-40 transition-all group-hover:translate-x-0.5 group-hover:-translate-y-0.5 group-hover:opacity-100" />
                    </button>
                  ))}
                </div>
              )}
            </div>
          );
        })()}

        <div className="flex flex-col gap-7">
          {messages.map((message) => (
            <MessageRow key={message.id} message={message} repo={repo} />
          ))}

          {/* Loading telemetry status before first token */}
          {showLoading && (
            <div className="flex flex-col items-start gap-2">
              <div className="flex items-center gap-2 font-mono text-[10px] tracking-[0.18em] text-muted-foreground uppercase">
                <span className="size-1.5 animate-pulse rounded-full bg-foreground" />
                <span>TRACE // RECEIVING</span>
              </div>
              <div className="flex flex-wrap items-center gap-3 border-l border-foreground/40 py-1 pl-4 font-mono text-xs text-muted-foreground">
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
                <span>TRACE // STREAMING</span>
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