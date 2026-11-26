"use client";

import Link from "next/link";
import { useState } from "react";
import {
  ArrowLeft,
  Check,
  Copy,
  KeyRound,
  Lock,
  ShieldCheck,
  Terminal,
} from "lucide-react";

import { BrandMark } from "@/components/layout/app-shell";
import { McpAccessDialog } from "@/components/mcp/mcp-access-dialog";
import { Button } from "@/components/ui/button";
import { ModeToggle } from "@/components/ui/mode-toggle";
import { getMcpEndpointUrl } from "@/lib/api";

type ClientTab = "cursor" | "claude" | "vscode" | "curl";

const TOOLS_REFERENCE = [
  {
    name: "list_sources",
    summary:
      "Lists all indexed knowledge sources (GitHub repos, PDFs, Jupyter notebooks, IaC configs, EPUB books) owned by your authenticated workspace.",
    params: [
      {
        name: "sourceType",
        type: "enum (optional)",
        desc: "GITHUB_REPO | PDF | NOTEBOOK | IAC | EPUB",
      },
      {
        name: "status",
        type: "enum (optional)",
        desc: "READY | INDEXING | PENDING | FAILED",
      },
    ],
    returns: "Source IDs, names, types, indexing status, vector chunk counts, and unit totals.",
  },
  {
    name: "search_knowledge",
    summary:
      "Executes 384-dim cosine similarity search across a single source or across every ready source in your workspace.",
    params: [
      {
        name: "query",
        type: "string (required)",
        desc: "Natural language question, symbol name, error message, or concept.",
      },
      {
        name: "sourceId",
        type: "UUID (optional)",
        desc: "Restrict search to one source ID from list_sources. Omit to search all workspace sources.",
      },
      {
        name: "topK",
        type: "integer (1–15, default 5)",
        desc: "Maximum ranked passages to return.",
      },
      {
        name: "similarityThreshold",
        type: "number (0.0–1.0, default 0.30)",
        desc: "Minimum cosine similarity score.",
      },
    ],
    returns:
      "Ranked passages with cosine scores and format-native citations (file:start-end, Page N, Chapter N, Cell N, or Block: <sig> (Line N)).",
  },
  {
    name: "get_source_details",
    summary:
      "Returns full metadata and indexing telemetry for one source strictly owned by your workspace.",
    params: [
      {
        name: "sourceId",
        type: "UUID (required)",
        desc: "Source UUID returned by list_sources.",
      },
    ],
    returns:
      "Source type, status, chunk count, unit count, branch/language or file name/size, indexed timestamp, and error state if any.",
  },
  {
    name: "get_source_excerpts",
    summary:
      "Reads ordered indexed chunks directly from a specific source without needing a vector query.",
    params: [
      {
        name: "sourceId",
        type: "UUID (required)",
        desc: "Source UUID returned by list_sources.",
      },
      {
        name: "filePath",
        type: "string (optional)",
        desc: "Exact file path inside a GitHub repository (e.g. src/App.tsx).",
      },
      {
        name: "unitNumber",
        type: "integer (optional)",
        desc: "1-based page (PDF), chapter (EPUB), cell (Notebook), or start line (IaC).",
      },
      {
        name: "offset",
        type: "integer (default 0)",
        desc: "Chunk pagination offset.",
      },
      {
        name: "limit",
        type: "integer (1–20, default 6)",
        desc: "Maximum chunks to return.",
      },
    ],
    returns: "Ordered text chunks with exact citation metadata.",
  },
] as const;

function buildClientConfig(tab: ClientTab, endpoint: string): { filename: string; code: string } {
  switch (tab) {
    case "cursor":
      return {
        filename: ".cursor/mcp.json",
        code: JSON.stringify(
          {
            mcpServers: {
              trace: {
                url: endpoint,
                headers: {
                  Authorization: "Bearer trc_live_YOUR_API_KEY",
                },
              },
            },
          },
          null,
          2
        ),
      };
    case "claude":
      return {
        filename: "claude_desktop_config.json (via mcp-remote)",
        code: JSON.stringify(
          {
            mcpServers: {
              trace: {
                command: "npx",
                args: [
                  "-y",
                  "mcp-remote",
                  endpoint,
                  "--header",
                  "Authorization:Bearer trc_live_YOUR_API_KEY",
                ],
              },
            },
          },
          null,
          2
        ),
      };
    case "vscode":
      return {
        filename: ".vscode/mcp.json (VS Code / Windsurf)",
        code: JSON.stringify(
          {
            servers: {
              trace: {
                type: "http",
                url: endpoint,
                headers: {
                  Authorization: "Bearer trc_live_YOUR_API_KEY",
                },
              },
            },
          },
          null,
          2
        ),
      };
    case "curl":
      return {
        filename: "JSON-RPC 2.0 (tools/list)",
        code: `curl -X POST "${endpoint}" \\\n  -H "Content-Type: application/json" \\\n  -H "Authorization: Bearer trc_live_YOUR_API_KEY" \\\n  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'`,
      };
  }
}

export default function DocsPage() {
  const [clientTab, setClientTab] = useState<ClientTab>("cursor");
  const [mcpOpen, setMcpOpen] = useState(false);
  const [copiedId, setCopiedId] = useState<string | null>(null);

  const endpoint = getMcpEndpointUrl();
  const snippet = buildClientConfig(clientTab, endpoint);

  async function copyText(text: string, id: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedId(id);
      window.setTimeout(() => {
        setCopiedId((prev) => (prev === id ? null : prev));
      }, 1800);
    } catch {
      // ignore clipboard errors
    }
  }

  return (
    <div className="min-h-screen bg-background text-foreground">
      {/* Minimal sticky header */}
      <header className="sticky top-0 z-30 h-14 border-b border-border/80 bg-background/85 backdrop-blur-md">
        <div className="mx-auto flex h-full w-full max-w-4xl items-center justify-between px-4 sm:px-6">
          <div className="flex items-center gap-4">
            <Link
              href="/"
              className="transition-opacity hover:opacity-80"
              aria-label="Back to TRACE home"
            >
              <BrandMark />
            </Link>
            <span className="hidden font-mono text-[10px] tracking-[0.18em] text-muted-foreground uppercase sm:inline">
              / DOCS // MCP
            </span>
          </div>

          <div className="flex items-center gap-2.5 sm:gap-4">
            <Link
              href="/"
              className="hidden items-center gap-1.5 font-mono text-[10px] tracking-[0.16em] text-muted-foreground uppercase transition-colors hover:text-foreground sm:inline-flex"
            >
              <ArrowLeft className="size-3" />
              <span>Home</span>
            </Link>
            <Link
              href="/dashboard"
              className="font-mono text-[10px] tracking-[0.16em] text-muted-foreground uppercase transition-colors hover:text-foreground"
            >
              Console
            </Link>
            <Button size="xs" variant="outline" onClick={() => setMcpOpen(true)}>
              <KeyRound className="size-3" />
              API Key
            </Button>
            <ModeToggle />
          </div>
        </div>
      </header>

      <main className="mx-auto w-full max-w-4xl space-y-10 px-4 py-8 sm:space-y-12 sm:px-6 sm:py-14">
        {/* Title & Overview */}
        <section className="space-y-4 border-b border-border pb-8">
          <p className="font-mono text-[10px] tracking-[0.22em] text-muted-foreground uppercase">
            MODEL CONTEXT PROTOCOL // STREAMABLE HTTP
          </p>
          <h1 className="font-heading text-3xl leading-tight font-semibold tracking-[0.04em] uppercase sm:text-5xl">
            TRACE MCP Server
          </h1>
          <p className="max-w-2xl text-sm leading-relaxed text-muted-foreground sm:text-base">
            Connect Cursor, Claude Desktop, VS Code, Windsurf, or any MCP-compatible agent directly to your indexed TRACE workspace. Every query runs against your 384-dim PgVector index across GitHub repositories, PDFs, Jupyter notebooks, IaC/CI configs, and EPUB books—returning grounded passages with exact citations.
          </p>

          <div className="flex flex-wrap items-center gap-3 pt-2">
            <Button size="sm" onClick={() => setMcpOpen(true)}>
              <KeyRound className="size-3.5" />
              Generate Workspace API Key
            </Button>
            <div className="flex w-full min-w-0 items-center gap-2 border border-border bg-card/70 px-3 py-1.5 font-mono text-xs sm:w-auto">
              <span className="shrink-0 text-muted-foreground">ENDPOINT</span>
              <code className="min-w-0 flex-1 truncate text-foreground">{endpoint}</code>
              <button
                type="button"
                onClick={() => void copyText(endpoint, "endpoint")}
                aria-label="Copy endpoint URL"
                className="shrink-0 text-muted-foreground transition-colors hover:text-foreground"
              >
                {copiedId === "endpoint" ? (
                  <Check className="size-3.5 text-foreground" />
                ) : (
                  <Copy className="size-3.5" />
                )}
              </button>
            </div>
          </div>
        </section>

        {/* Quick Setup Guide */}
        <section className="space-y-5">
          <div className="space-y-1">
            <p className="font-mono text-[10px] tracking-[0.2em] text-muted-foreground uppercase">
              01 // QUICK SETUP
            </p>
            <h2 className="font-heading text-xl font-semibold tracking-[0.06em] uppercase sm:text-2xl">
              Connect in under a minute
            </h2>
          </div>

          <ol className="grid gap-3 sm:grid-cols-3">
            {[
              {
                num: "01",
                title: "Index a Source",
                body: "Paste a GitHub repo URL or upload a PDF, .ipynb, .tf, Dockerfile, or .epub in TRACE.",
              },
              {
                num: "02",
                title: "Generate API Key",
                body: "Open the MCP Key modal and copy your one-time trc_live_... token immediately.",
              },
              {
                num: "03",
                title: "Add Client Config",
                body: "Paste the JSON snippet below into your MCP client and replace YOUR_API_KEY.",
              },
            ].map((step) => (
              <li
                key={step.num}
                className="space-y-1.5 border border-border/80 bg-card/60 p-4"
              >
                <span className="font-mono text-[10px] tracking-[0.18em] text-muted-foreground">
                  STEP {step.num}
                </span>
                <p className="font-heading text-sm font-semibold tracking-[0.06em] uppercase">
                  {step.title}
                </p>
                <p className="text-xs leading-relaxed text-muted-foreground">
                  {step.body}
                </p>
              </li>
            ))}
          </ol>

          {/* Tabbed copyable client configuration */}
          <div className="border border-border bg-card/70">
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-3 py-2">
              <div className="flex flex-wrap items-center gap-1" role="tablist">
                {(
                  [
                    { id: "cursor", label: "Cursor" },
                    { id: "claude", label: "Claude Desktop" },
                    { id: "vscode", label: "VS Code / Windsurf" },
                    { id: "curl", label: "HTTP / cURL" },
                  ] as const
                ).map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    role="tab"
                    aria-selected={clientTab === item.id}
                    onClick={() => setClientTab(item.id)}
                    className={`rounded-[2px] px-2.5 py-1 font-mono text-[10px] tracking-[0.12em] uppercase transition-colors ${
                      clientTab === item.id
                        ? "bg-foreground text-background"
                        : "text-muted-foreground hover:text-foreground"
                    }`}
                  >
                    {item.label}
                  </button>
                ))}
              </div>

              <button
                type="button"
                onClick={() => void copyText(snippet.code, `snippet-${clientTab}`)}
                className="inline-flex items-center gap-1.5 rounded-[2px] border border-border px-2.5 py-1 font-mono text-[10px] tracking-[0.12em] text-muted-foreground uppercase transition-colors hover:border-foreground hover:text-foreground"
              >
                {copiedId === `snippet-${clientTab}` ? (
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

            <div className="border-b border-border/60 bg-background/40 px-4 py-1.5 font-mono text-[10px] text-muted-foreground">
              {snippet.filename}
            </div>
            <pre className="overflow-x-auto p-4 font-mono text-xs leading-relaxed text-foreground">
              <code>{snippet.code}</code>
            </pre>
          </div>
        </section>

        {/* Authentication & Security */}
        <section className="space-y-4">
          <div className="space-y-1">
            <p className="font-mono text-[10px] tracking-[0.2em] text-muted-foreground uppercase">
              02 // AUTHENTICATION &amp; ISOLATION
            </p>
            <h2 className="font-heading text-xl font-semibold tracking-[0.06em] uppercase sm:text-2xl">
              Security Model
            </h2>
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-2 border border-border/80 bg-card/60 p-4">
              <div className="flex items-center gap-2 font-mono text-[10px] tracking-[0.16em] text-foreground uppercase">
                <Lock className="size-3.5" />
                <span>Hash-Only Key Storage</span>
              </div>
              <p className="text-xs leading-relaxed text-muted-foreground">
                Keys are generated with 256 bits of cryptographic entropy (<code className="font-mono text-foreground">trc_live_...</code>). Only the one-way SHA-256 hash is stored in PostgreSQL—plaintext keys are displayed once at creation and never stored on disk or in browser storage.
              </p>
            </div>

            <div className="space-y-2 border border-border/80 bg-card/60 p-4">
              <div className="flex items-center gap-2 font-mono text-[10px] tracking-[0.16em] text-foreground uppercase">
                <ShieldCheck className="size-3.5" />
                <span>Strict Per-Workspace Scoping</span>
              </div>
              <p className="text-xs leading-relaxed text-muted-foreground">
                Every request to <code className="font-mono text-foreground">/api/mcp</code> must pass <code className="font-mono text-foreground">Authorization: Bearer &lt;key&gt;</code> (or <code className="font-mono text-foreground">X-API-Key</code>). Missing, invalid, or revoked keys return <code className="font-mono text-foreground">401 Unauthorized</code>. All SQL and PgVector filters enforce your workspace owner ID at the database layer.
              </p>
            </div>
          </div>
        </section>

        {/* Available Tools Reference */}
        <section className="space-y-5">
          <div className="space-y-1">
            <p className="font-mono text-[10px] tracking-[0.2em] text-muted-foreground uppercase">
              03 // TOOLS REFERENCE
            </p>
            <h2 className="font-heading text-xl font-semibold tracking-[0.06em] uppercase sm:text-2xl">
              Exposed MCP Tools
            </h2>
          </div>

          <div className="space-y-4">
            {TOOLS_REFERENCE.map((tool) => (
              <div
                key={tool.name}
                className="border border-border/80 bg-card/60"
              >
                <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border/70 px-4 py-3">
                  <div className="flex items-center gap-2">
                    <Terminal className="size-3.5 text-muted-foreground" />
                    <code className="font-mono text-sm font-semibold text-foreground">
                      {tool.name}
                    </code>
                  </div>
                  <span className="font-mono text-[10px] tracking-[0.14em] text-muted-foreground uppercase">
                    tools/call
                  </span>
                </div>

                <div className="space-y-4 p-4">
                  <p className="text-xs leading-relaxed text-muted-foreground sm:text-sm">
                    {tool.summary}
                  </p>

                  <div className="space-y-2">
                    <p className="font-mono text-[10px] tracking-[0.16em] text-muted-foreground uppercase">
                      Parameters
                    </p>
                    <div className="divide-y divide-border/60 border border-border/70 bg-background/50">
                      {tool.params.map((p) => (
                        <div
                          key={p.name}
                          className="grid gap-1 px-3 py-2 text-xs sm:grid-cols-[11rem_11rem_1fr] sm:items-baseline sm:gap-3"
                        >
                          <code className="font-mono font-medium text-foreground">
                            {p.name}
                          </code>
                          <span className="font-mono text-[10px] text-muted-foreground">
                            {p.type}
                          </span>
                          <span className="text-muted-foreground">{p.desc}</span>
                        </div>
                      ))}
                    </div>
                  </div>

                  <p className="text-xs text-muted-foreground">
                    <span className="font-mono text-[10px] tracking-[0.14em] text-foreground uppercase">
                      Returns:{" "}
                    </span>
                    {tool.returns}
                  </p>
                </div>
              </div>
            ))}
          </div>
        </section>

        {/* Bottom nav */}
        <footer className="flex flex-wrap items-center justify-between gap-4 border-t border-border pt-6 font-mono text-[10px] tracking-[0.16em] text-muted-foreground uppercase">
          <Link
            href="/"
            className="inline-flex items-center gap-1.5 text-foreground transition-opacity hover:opacity-80"
          >
            <ArrowLeft className="size-3" />
            <span>Back to Home</span>
          </Link>
          <span>TRACE MCP SERVER · PROTOCOL 2025-03-26</span>
        </footer>
      </main>

      <McpAccessDialog open={mcpOpen} onOpenChange={setMcpOpen} />
    </div>
  );
}
