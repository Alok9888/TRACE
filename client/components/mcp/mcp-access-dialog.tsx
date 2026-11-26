"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import {
  AlertTriangle,
  ArrowUpRight,
  Check,
  Copy,
  KeyRound,
  Loader2,
  RefreshCw,
  ShieldCheck,
  Trash2,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  api,
  getMcpEndpointUrl,
  type McpKeyStatusResponse,
} from "@/lib/api";

export function McpAccessDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90dvh] w-[calc(100vw-1.5rem)] overflow-y-auto rounded-[2px] border-border bg-card p-4 sm:max-w-lg sm:p-6">
        {open ? (
          <McpAccessDialogBody onClose={() => onOpenChange(false)} />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function McpAccessDialogBody({ onClose }: { onClose: () => void }) {
  const [status, setStatus] = useState<McpKeyStatusResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [mutating, setMutating] = useState(false);
  const [error, setError] = useState("");
  // Held strictly in component memory — unmounted & wiped immediately when dialog closes
  const [oneTimePlaintextKey, setOneTimePlaintextKey] = useState<string | null>(null);
  const [copiedField, setCopiedField] = useState<"endpoint" | "key" | null>(null);

  const mcpEndpoint = getMcpEndpointUrl();

  useEffect(() => {
    let cancelled = false;
    api
      .getMcpKeyStatus()
      .then((data) => {
        if (!cancelled) {
          setStatus(data);
          setError("");
          setLoading(false);
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "Could not load MCP key status.");
          setLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function handleCopy(value: string, field: "endpoint" | "key") {
    try {
      await navigator.clipboard.writeText(value);
      setCopiedField(field);
      window.setTimeout(() => {
        setCopiedField((prev) => (prev === field ? null : prev));
      }, 1800);
    } catch {
      setError("Clipboard copy failed. Select and copy the value manually.");
    }
  }

  async function handleGenerate() {
    if (mutating) return;
    setMutating(true);
    setError("");
    try {
      const generated = await api.generateMcpKey();
      setOneTimePlaintextKey(generated.apiKey);
      setStatus({
        hasActiveKey: true,
        id: generated.id,
        maskedKey: generated.maskedKey,
        keyPrefix: generated.keyPrefix,
        keyLast4: generated.keyLast4,
        label: generated.label,
        createdAt: generated.createdAt,
        lastUsedAt: null,
        mcpEndpointPath: generated.mcpEndpointPath,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not generate MCP API key.");
    } finally {
      setMutating(false);
    }
  }

  async function handleRevoke() {
    if (mutating) return;
    setMutating(true);
    setError("");
    try {
      await api.revokeMcpKey();
      setOneTimePlaintextKey(null);
      setStatus({
        hasActiveKey: false,
        id: null,
        maskedKey: null,
        keyPrefix: null,
        keyLast4: null,
        label: null,
        createdAt: null,
        lastUsedAt: null,
        mcpEndpointPath: "/api/mcp",
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not revoke MCP API key.");
    } finally {
      setMutating(false);
    }
  }

  return (
    <>
      <DialogHeader>
          <div className="flex items-center gap-2 font-mono text-[10px] tracking-[0.2em] text-muted-foreground uppercase">
            <ShieldCheck className="size-3.5 text-foreground" />
            <span>MCP // TENANT-ISOLATED ACCESS</span>
          </div>
          <DialogTitle className="font-heading text-base font-semibold tracking-[0.12em] uppercase">
            Connect External Agents via MCP
          </DialogTitle>
          <DialogDescription className="text-xs leading-relaxed">
            Query your workspace&apos;s indexed GitHub repos, PDFs, notebooks, IaC configs, and EPUB books directly from Cursor, Claude Desktop, VS Code, or Windsurf.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          {/* Dynamic MCP Endpoint URL */}
          <div className="space-y-1.5">
            <span className="font-mono text-[10px] tracking-[0.16em] text-muted-foreground uppercase">
              MCP Streamable HTTP Endpoint
            </span>
            <div className="flex items-center gap-2 border border-border bg-background/80 px-3 py-2">
              <code className="min-w-0 flex-1 truncate font-mono text-xs text-foreground">
                {mcpEndpoint}
              </code>
              <button
                type="button"
                onClick={() => void handleCopy(mcpEndpoint, "endpoint")}
                aria-label="Copy MCP endpoint URL"
                className="inline-flex shrink-0 items-center gap-1 rounded-[2px] border border-border px-2 py-1 font-mono text-[10px] tracking-[0.1em] text-muted-foreground uppercase transition-colors hover:border-foreground hover:text-foreground"
              >
                {copiedField === "endpoint" ? (
                  <>
                    <Check className="size-3 text-foreground" />
                    <span>Copied</span>
                  </>
                ) : (
                  <>
                    <Copy className="size-3" />
                    <span>Copy</span>
                  </>
                )}
              </button>
            </div>
          </div>

          {/* One-Time Plaintext Key Reveal + Warning */}
          {oneTimePlaintextKey ? (
            <div className="space-y-3 border border-foreground/70 bg-foreground/[0.04] p-3.5">
              <div className="flex items-start gap-2.5">
                <AlertTriangle className="mt-0.5 size-4 shrink-0 text-foreground" />
                <div className="space-y-1">
                  <p className="font-mono text-[11px] font-semibold tracking-[0.12em] text-foreground uppercase">
                    Shown Only Once — Save This Key Now
                  </p>
                  <p className="text-xs leading-relaxed text-muted-foreground">
                    TRACE stores only a one-way SHA-256 hash. Once you dismiss this dialog, this plaintext key cannot be retrieved again—you will need to regenerate a new one.
                  </p>
                </div>
              </div>

              <div className="flex flex-col items-stretch gap-2 border border-foreground/40 bg-background px-3 py-2 sm:flex-row sm:items-center">
                <code className="min-w-0 flex-1 break-all font-mono text-xs text-foreground select-all">
                  {oneTimePlaintextKey}
                </code>
                <button
                  type="button"
                  onClick={() => void handleCopy(oneTimePlaintextKey, "key")}
                  aria-label="Copy generated MCP API key"
                  className="inline-flex shrink-0 items-center justify-center gap-1 rounded-[2px] border border-foreground bg-foreground px-2.5 py-1.5 font-mono text-[10px] font-medium tracking-[0.1em] text-background uppercase transition-opacity hover:opacity-90 sm:py-1"
                >
                  {copiedField === "key" ? (
                    <>
                      <Check className="size-3" />
                      <span>Copied</span>
                    </>
                  ) : (
                    <>
                      <Copy className="size-3" />
                      <span>Copy Key</span>
                    </>
                  )}
                </button>
              </div>

              <div className="flex justify-end">
                <button
                  type="button"
                  onClick={() => setOneTimePlaintextKey(null)}
                  className="font-mono text-[10px] tracking-[0.14em] text-muted-foreground uppercase underline-offset-4 hover:text-foreground hover:underline"
                >
                  I&apos;ve saved this key · Hide plaintext
                </button>
              </div>
            </div>
          ) : (
            /* Active Masked Key or Empty State */
            <div className="space-y-2">
              <span className="font-mono text-[10px] tracking-[0.16em] text-muted-foreground uppercase">
                Workspace API Key
              </span>

              {loading ? (
                <div className="flex items-center gap-2 border border-border bg-background/60 px-3 py-3 font-mono text-xs text-muted-foreground">
                  <Loader2 className="size-3.5 animate-spin" />
                  <span>Checking workspace key status...</span>
                </div>
              ) : status?.hasActiveKey ? (
                <div className="space-y-2.5 border border-border bg-background/70 p-3">
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-2">
                      <span className="size-1.5 rounded-full bg-foreground" />
                      <code className="font-mono text-xs text-foreground">
                        {status.maskedKey}
                      </code>
                    </div>
                    <span className="rounded-[2px] border border-foreground/30 px-1.5 py-0.5 font-mono text-[9px] tracking-[0.14em] text-foreground uppercase">
                      Active
                    </span>
                  </div>
                  <div className="flex flex-wrap items-center gap-x-4 gap-y-1 font-mono text-[10px] text-muted-foreground">
                    {status.createdAt && (
                      <span>
                        CREATED {new Date(status.createdAt).toLocaleDateString()}
                      </span>
                    )}
                    <span>
                      {status.lastUsedAt
                        ? `LAST USED ${new Date(status.lastUsedAt).toLocaleDateString()}`
                        : "NOT YET USED"}
                    </span>
                  </div>
                </div>
              ) : (
                <div className="border border-dashed border-border bg-background/40 px-3 py-3 text-xs text-muted-foreground">
                  No active MCP API key for this workspace. Generate one to authenticate external clients via <code className="font-mono text-[11px] text-foreground">Authorization: Bearer</code>.
                </div>
              )}
            </div>
          )}

          {error && (
            <p role="alert" className="font-mono text-xs text-destructive">
              ERR // {error}
            </p>
          )}

          {/* Action row */}
          <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border/80 pt-3">
            <div className="flex items-center gap-2">
              <Button
                type="button"
                size="sm"
                disabled={mutating || loading}
                onClick={() => void handleGenerate()}
              >
                {mutating ? (
                  <Loader2 className="size-3.5 animate-spin" />
                ) : status?.hasActiveKey ? (
                  <RefreshCw className="size-3.5" />
                ) : (
                  <KeyRound className="size-3.5" />
                )}
                {status?.hasActiveKey ? "Revoke & Regenerate" : "Generate API Key"}
              </Button>

              {status?.hasActiveKey && (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={mutating || loading}
                  onClick={() => void handleRevoke()}
                  className="border-destructive/40 text-destructive hover:border-destructive hover:bg-destructive hover:text-white"
                >
                  <Trash2 className="size-3.5" />
                  Revoke
                </Button>
              )}
            </div>

            <Link
              href="/docs"
              onClick={onClose}
              className="group inline-flex items-center gap-1 font-mono text-[10px] font-medium tracking-[0.16em] text-muted-foreground uppercase transition-colors hover:text-foreground"
            >
              <span>MCP Setup Docs</span>
              <ArrowUpRight className="size-3 transition-transform duration-200 group-hover:translate-x-0.5 group-hover:-translate-y-0.5" />
            </Link>
          </div>
        </div>
    </>
  );
}
