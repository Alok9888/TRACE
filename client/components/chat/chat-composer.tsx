"use client";

import { memo, useState } from "react";
import { SendHorizontal, Square } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Kbd } from "@/components/ui/kbd";
import { Spinner } from "@/components/ui/spinner";

export const ChatComposer = memo(function ChatComposer({
  disabled,
  streaming,
  onSend,
  onStop,
}: {
  disabled?: boolean;
  streaming?: boolean;
  onSend: (content: string) => void | Promise<void>;
  onStop?: () => void;
}) {
  const [value, setValue] = useState("");

  async function submit() {
    const content = value.trim();
    if (!content || disabled || streaming) return;
    setValue("");
    await onSend(content);
  }

  return (
    <div className="shrink-0 border-t border-border bg-background/90 px-3 py-3 backdrop-blur-md sm:px-5 sm:py-4">
      <div className="mx-auto max-w-3xl space-y-2">
        <div className="flex items-end gap-2 rounded-[2px] border border-input bg-card p-1.5 transition-colors focus-within:border-foreground sm:p-2">
          <Textarea
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder="Ask about architecture, files, or symbols..."
            disabled={disabled}
            className="min-h-11 flex-1 resize-none border-0 bg-transparent px-2.5 py-2 text-sm shadow-none focus-visible:ring-0"
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
              className="h-9 px-3"
            >
              <Square className="size-3" />
              Stop
            </Button>
          ) : (
            <Button
              size="sm"
              disabled={disabled || !value.trim()}
              onClick={() => void submit()}
              aria-label="Send message"
              className="h-9 px-4"
            >
              {disabled ? <Spinner /> : <SendHorizontal className="size-3.5" />}
              Send
            </Button>
          )}
        </div>
        <div className="flex items-center justify-between px-0.5 font-mono text-[10px] tracking-[0.1em] text-muted-foreground uppercase">
          <span>
            <Kbd>Enter</Kbd> send · <Kbd>Shift+Enter</Kbd> newline
          </span>
        </div>
      </div>
    </div>
  );
});
