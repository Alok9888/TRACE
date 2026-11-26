"use client";

import { memo, useState } from "react";
import { SendHorizontal, Square } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Kbd } from "@/components/ui/kbd";
import { Spinner } from "@/components/ui/spinner";
import type { SourceType } from "@/lib/api";

export const ChatComposer = memo(function ChatComposer({
  disabled,
  streaming,
  sourceType,
  onSend,
  onStop,
}: {
  disabled?: boolean;
  streaming?: boolean;
  sourceType?: SourceType;
  onSend: (content: string) => void | Promise<void>;
  onStop?: () => void;
}) {
  const [value, setValue] = useState("");
  const placeholder =
    sourceType === "PDF"
      ? "Query sections, claims, or specific pages..."
      : sourceType === "EPUB"
        ? "Query chapters, concepts, or technical patterns..."
        : sourceType === "NOTEBOOK"
          ? "Query notebook cells, pipelines, or metrics..."
          : sourceType === "IAC"
            ? "Query Terraform resources, Docker stages, or CI jobs..."
            : "Query architecture, execution flows, or indexed context...";

  async function submit() {
    const content = value.trim();
    if (!content || disabled || streaming) return;
    setValue("");
    await onSend(content);
  }

  return (
    <div className="shrink-0 border-t border-border bg-background/90 px-3 pt-2.5 pb-[max(0.75rem,env(safe-area-inset-bottom))] backdrop-blur-md sm:px-5 sm:py-4">
      <div className="mx-auto max-w-3xl space-y-2">
        <div className="flex items-end gap-2 rounded-[2px] border border-input bg-card p-1.5 transition-colors focus-within:border-foreground sm:p-2">
          <Textarea
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder={placeholder}
            disabled={disabled}
            className="min-h-11 flex-1 resize-none border-0 bg-transparent px-2.5 py-2 text-base shadow-none focus-visible:ring-0 sm:text-sm"
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void submit();
              }
            }}
          />
          {streaming ? (
            <Button
              size="sm"
              variant="outline"
              onClick={onStop}
              aria-label="Stop generating"
              className="h-10 shrink-0 px-3 sm:h-9"
            >
              <Square className="size-3" />
              Abort
            </Button>
          ) : (
            <Button
              size="sm"
              disabled={disabled || !value.trim()}
              onClick={() => void submit()}
              aria-label="Send message"
              className="h-10 shrink-0 px-3.5 sm:h-9 sm:px-4"
            >
              {disabled ? <Spinner /> : <SendHorizontal className="size-3.5" />}
              Send
            </Button>
          )}
        </div>
        <div className="hidden items-center justify-between px-0.5 font-mono text-[10px] tracking-[0.12em] text-muted-foreground uppercase sm:flex">
          <span>
            <Kbd>ENTER</Kbd> TRANSMIT · <Kbd>SHIFT+ENTER</Kbd> NEWLINE
          </span>
          <span>GROUNDED RAG // 384-DIM</span>
        </div>
      </div>
    </div>
  );
});
