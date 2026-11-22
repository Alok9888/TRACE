"use client";

import { memo, useState } from "react";
import { formatDistanceToNow } from "date-fns";
import { ChevronDown, Plus, RotateCcw, SlidersHorizontal } from "lucide-react";

import { IndexStatusBadge } from "@/components/dashboard/repo-status";
import { SourceTypeIcon } from "@/components/icons/source-type-icon";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import {
  useChatSessions,
  useCreateChatSession,
} from "@/hooks/use-chat";
import { useStartIndexing } from "@/hooks/use-repos";
import {
  formatFileSize,
  getSourceTypeMeta,
  isUploadedSource,
  type Repository,
} from "@/lib/api";
import {
  CHAT_CONFIG_LIMITS,
  DEFAULT_CHAT_CONFIG,
  isDefaultChatConfig,
  type ChatConfig,
} from "@/lib/chat-config";
import { cn } from "@/lib/utils";

type SidebarTab = "logs" | "params";

function ParamControl({
  id,
  label,
  valueLabel,
  min,
  max,
  step,
  value,
  lowHint,
  highHint,
  onChange,
}: {
  id: string;
  label: string;
  valueLabel: string;
  min: number;
  max: number;
  step: number;
  value: number;
  lowHint: string;
  highHint: string;
  onChange: (next: number) => void;
}) {
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between gap-2">
        <label
          htmlFor={id}
          className="font-mono text-[10px] tracking-[0.14em] text-muted-foreground uppercase"
        >
          {label}
        </label>
        <span className="tabular-telemetry font-mono text-[11px] font-medium text-foreground">
          {valueLabel}
        </span>
      </div>
      <input
        id={id}
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="range-telemetry"
      />
      <div className="flex items-center justify-between font-mono text-[9px] tracking-[0.1em] text-muted-foreground/70 uppercase">
        <span>{lowHint}</span>
        <span>{highHint}</span>
      </div>
    </div>
  );
}

export const ChatSidebar = memo(function ChatSidebar({
  repo,
  sessionId,
  onSelectSession,
  config,
  onConfigChange,
}: {
  repo: Repository;
  sessionId: string | null;
  onSelectSession: (id: string) => void;
  config: ChatConfig;
  onConfigChange: (next: ChatConfig) => void;
}) {
  const ready = repo.indexStatus === "READY";
  const uploaded = isUploadedSource(repo);
  const typeMeta = getSourceTypeMeta(repo.sourceType);
  const sessionsQuery = useChatSessions(repo.id, ready);
  const createSession = useCreateChatSession(repo.id);
  const reindex = useStartIndexing();

  // Desktop active tab ("logs" | "params"); Mobile collapsible drawer ("logs" | "params" | null)
  const [desktopTab, setDesktopTab] = useState<SidebarTab>("logs");
  const [mobilePanel, setMobilePanel] = useState<SidebarTab | null>(null);

  const activeSession = sessionsQuery.data?.find((s) => s.id === sessionId);
  const isCustomized = !isDefaultChatConfig(config);

  function updateField<K extends keyof ChatConfig>(key: K, value: ChatConfig[K]) {
    onConfigChange({ ...config, [key]: value });
  }

  function resetConfig() {
    onConfigChange(DEFAULT_CHAT_CONFIG);
  }

  const showLogs = desktopTab === "logs";
  const showParams = desktopTab === "params";

  return (
    <aside className="sticky top-13 z-10 flex w-full shrink-0 flex-col border-b border-border bg-sidebar md:h-full md:w-72 md:overflow-hidden md:border-r md:border-b-0">
      {/* Compact mobile bar (< md) so chat gets the full viewport height */}
      <div className="flex items-center justify-between gap-2 px-3 py-2 md:hidden">
        <button
          type="button"
          onClick={() =>
            setMobilePanel((prev) => (prev === "logs" ? null : "logs"))
          }
          className="flex min-w-0 flex-1 items-center gap-2 text-left"
        >
          <IndexStatusBadge status={repo.indexStatus} />
          <span className="truncate font-mono text-[11px] tracking-[0.06em] text-foreground">
            {activeSession?.title ?? repo.name}
          </span>
          <ChevronDown
            className={cn(
              "size-3.5 shrink-0 text-muted-foreground transition-transform",
              mobilePanel === "logs" && "rotate-180"
            )}
          />
        </button>

        <div className="flex shrink-0 items-center gap-1.5">
          <Button
            size="icon-xs"
            variant={mobilePanel === "params" ? "default" : "outline"}
            onClick={() =>
              setMobilePanel((prev) => (prev === "params" ? null : "params"))
            }
            aria-label="Configure LLM and retrieval parameters"
            className="relative"
          >
            <SlidersHorizontal className="size-3" />
            {isCustomized && mobilePanel !== "params" && (
              <span className="absolute -top-0.5 -right-0.5 size-1.5 rounded-full bg-foreground" />
            )}
          </Button>
          <Button
            size="xs"
            disabled={!ready || createSession.isPending}
            onClick={() =>
              createSession.mutate("New chat", {
                onSuccess: (session) => {
                  onSelectSession(session.id);
                  setMobilePanel(null);
                },
              })
            }
          >
            <Plus className="size-3" />
            New
          </Button>
          {!uploaded && (
            <Button
              size="icon-xs"
              variant="outline"
              disabled={reindex.isPending || repo.indexStatus === "INDEXING"}
              onClick={() => reindex.mutate(repo.id)}
              aria-label="Re-index source"
            >
              <RotateCcw className="size-3" />
            </Button>
          )}
        </div>
      </div>

      {/* Desktop source header */}
      <div className="hidden space-y-3.5 p-4 md:block">
        <div className="space-y-1.5">
          <div className="flex items-center justify-between gap-2">
            <p className="flex items-center gap-1.5 font-mono text-[10px] tracking-[0.18em] text-muted-foreground uppercase">
              <SourceTypeIcon sourceType={repo.sourceType} className="size-3" />
              <span>TARGET SOURCE</span>
            </p>
            <span className="rounded-[2px] border border-border px-1.5 py-0.5 font-mono text-[9px] tracking-[0.14em] text-foreground/85 uppercase">
              {typeMeta.badge}
            </span>
          </div>
          <p className="truncate font-heading text-sm font-semibold tracking-[0.06em]">
            {repo.fullName}
          </p>
          <div className="flex flex-wrap items-center gap-2 pt-0.5">
            <IndexStatusBadge status={repo.indexStatus} />
            {uploaded && repo.pageCount != null && repo.pageCount > 0 && (
              <span className="tabular-telemetry font-mono text-[10px] tracking-[0.1em] text-muted-foreground uppercase">
                {repo.pageCount}{" "}
                {repo.pageCount === 1 ? typeMeta.unitSingular : typeMeta.unitPlural}
              </span>
            )}
            {uploaded && repo.fileSizeBytes != null && repo.fileSizeBytes > 0 && (
              <span className="tabular-telemetry font-mono text-[10px] tracking-[0.1em] text-muted-foreground uppercase">
                {formatFileSize(repo.fileSizeBytes)}
              </span>
            )}
            {repo.chunkCount > 0 && (
              <span className="tabular-telemetry font-mono text-[10px] tracking-[0.1em] text-muted-foreground uppercase">
                {repo.chunkCount.toLocaleString()} VECTORS
              </span>
            )}
            {!uploaded && repo.isPrivate && (
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
                onSuccess: (session) => {
                  onSelectSession(session.id);
                  setDesktopTab("logs");
                },
              })
            }
          >
            <Plus data-icon="inline-start" />
            New Channel
          </Button>
          {!uploaded && (
            <Button
              size="sm"
              variant="outline"
              disabled={reindex.isPending || repo.indexStatus === "INDEXING"}
              onClick={() => reindex.mutate(repo.id)}
              aria-label="Re-index source"
            >
              <RotateCcw className="size-3.5" />
            </Button>
          )}
        </div>
      </div>

      <Separator className={cn(!mobilePanel && "hidden md:block")} />

      {/* Desktop 2-mode switcher: Comms Logs | Parameters */}
      <div className="hidden grid-cols-2 border-b border-border/80 md:grid">
        <button
          type="button"
          onClick={() => setDesktopTab("logs")}
          className={cn(
            "border-b-2 px-3 py-2.5 font-mono text-[10px] font-medium tracking-[0.16em] uppercase transition-colors",
            showLogs
              ? "border-b-foreground text-foreground"
              : "border-b-transparent text-muted-foreground hover:text-foreground"
          )}
        >
          Logs {sessionsQuery.data ? `(${sessionsQuery.data.length})` : ""}
        </button>
        <button
          type="button"
          onClick={() => setDesktopTab("params")}
          className={cn(
            "flex items-center justify-center gap-1.5 border-b-2 px-3 py-2.5 font-mono text-[10px] font-medium tracking-[0.16em] uppercase transition-colors",
            showParams
              ? "border-b-foreground text-foreground"
              : "border-b-transparent text-muted-foreground hover:text-foreground"
          )}
        >
          <span>Params</span>
          {isCustomized && (
            <span
              className="size-1.5 rounded-full bg-foreground"
              title="Custom parameters active"
            />
          )}
        </button>
      </div>

      {/* Comms Logs list (visible on desktop when Logs tab active, or on mobile when mobilePanel === 'logs') */}
      <ScrollArea
        className={cn(
          "min-h-0 max-h-56 overflow-hidden border-t border-border/60 md:max-h-none md:flex-1 md:border-t-0",
          mobilePanel === "logs" ? "block" : "hidden",
          showLogs ? "md:block" : "md:hidden"
        )}
      >
        <div className="space-y-1 px-2 py-2 md:py-2.5 md:pb-4">
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
                setMobilePanel(null);
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

      {/* LLM & Retrieval Parameters panel (desktop Params tab OR mobile params drawer) */}
      <ScrollArea
        className={cn(
          "min-h-0 max-h-[60svh] overflow-hidden border-t border-border/60 md:max-h-none md:flex-1 md:border-t-0",
          mobilePanel === "params" ? "block" : "hidden",
          showParams ? "md:block" : "md:hidden"
        )}
      >
        <div className="space-y-4 px-4 py-3.5 pb-5">
          <div className="flex items-center justify-between md:hidden">
            <span className="font-mono text-[10px] font-medium tracking-[0.18em] text-foreground uppercase">
              LLM &amp; RAG Parameters
            </span>
            <button
              type="button"
              onClick={() => setMobilePanel(null)}
              className="font-mono text-[10px] tracking-[0.14em] text-muted-foreground uppercase hover:text-foreground"
            >
              Done
            </button>
          </div>

          <ParamControl
            id="param-temperature"
            label="Temperature"
            valueLabel={config.temperature.toFixed(2)}
            min={CHAT_CONFIG_LIMITS.temperature.min}
            max={CHAT_CONFIG_LIMITS.temperature.max}
            step={CHAT_CONFIG_LIMITS.temperature.step}
            value={config.temperature}
            lowHint="0.0 Precise"
            highHint="1.0 Creative"
            onChange={(v) => updateField("temperature", v)}
          />

          <ParamControl
            id="param-max-tokens"
            label="Max Tokens"
            valueLabel={String(config.maxTokens)}
            min={CHAT_CONFIG_LIMITS.maxTokens.min}
            max={CHAT_CONFIG_LIMITS.maxTokens.max}
            step={CHAT_CONFIG_LIMITS.maxTokens.step}
            value={config.maxTokens}
            lowHint="256 Short"
            highHint="4096 Extended"
            onChange={(v) => updateField("maxTokens", v)}
          />

          <Separator className="opacity-60" />

          <ParamControl
            id="param-top-k"
            label="Top K Chunks"
            valueLabel={String(config.topK)}
            min={CHAT_CONFIG_LIMITS.topK.min}
            max={CHAT_CONFIG_LIMITS.topK.max}
            step={CHAT_CONFIG_LIMITS.topK.step}
            value={config.topK}
            lowHint="1 Focused"
            highHint="10 Wide"
            onChange={(v) => updateField("topK", v)}
          />

          <ParamControl
            id="param-similarity"
            label="Similarity Threshold"
            valueLabel={config.similarityThreshold.toFixed(2)}
            min={CHAT_CONFIG_LIMITS.similarityThreshold.min}
            max={CHAT_CONFIG_LIMITS.similarityThreshold.max}
            step={CHAT_CONFIG_LIMITS.similarityThreshold.step}
            value={config.similarityThreshold}
            lowHint="0.0 Broad"
            highHint="1.0 Strict"
            onChange={(v) => updateField("similarityThreshold", v)}
          />

          <Separator className="opacity-60" />

          <div className="space-y-1.5">
            <div className="flex items-center justify-between gap-2">
              <label
                htmlFor="param-system-prompt"
                className="font-mono text-[10px] tracking-[0.14em] text-muted-foreground uppercase"
              >
                System Prompt
              </label>
              <span className="tabular-telemetry font-mono text-[9px] text-muted-foreground/75">
                {config.systemPrompt.length}/{CHAT_CONFIG_LIMITS.systemPromptMaxLength}
              </span>
            </div>
            <textarea
              id="param-system-prompt"
              rows={3}
              maxLength={CHAT_CONFIG_LIMITS.systemPromptMaxLength}
              value={config.systemPrompt}
              onChange={(e) => updateField("systemPrompt", e.target.value)}
              placeholder="e.g. Explain like senior engineer"
              className="w-full resize-y rounded-[2px] border border-input bg-background/80 px-2.5 py-2 font-mono text-[11px] leading-relaxed text-foreground outline-none transition-colors placeholder:text-muted-foreground/55 focus:border-foreground"
            />
          </div>

          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={!isCustomized}
            onClick={resetConfig}
            className="w-full"
          >
            Reset Defaults
          </Button>
        </div>
      </ScrollArea>
    </aside>
  );
});
