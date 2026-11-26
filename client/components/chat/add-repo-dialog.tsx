"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowRight, BookOpen, FileCode2, FileText, GitBranch, Layers, ServerCog } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";

import { FileUploadZone, type UploadFormat } from "@/components/landing/file-upload-zone";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { toast } from "@/components/ui/toast";
import { api, type Repository } from "@/lib/api";
import { queryKeys } from "@/lib/query-keys";

type DialogTab = "repo" | "pdf" | "devdocs";
type DevFormat = "notebook" | "iac" | "epub";

export function AddRepoDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const [tab, setTab] = useState<DialogTab>("repo");
  const [devFormat, setDevFormat] = useState<DevFormat>("notebook");
  const [repoUrl, setRepoUrl] = useState("");

  const activeUploadFormat: UploadFormat = tab === "pdf" ? "pdf" : devFormat;

  const extractGitHubOwnerName = (url: string): { owner: string; name: string } | null => {
    try {
      const match = url.match(/github\.com\/([^/]+)\/([^/?#]+)/);
      if (match) {
        return { owner: match[1], name: match[2].replace(/\.git$/, "") };
      }
      return null;
    } catch {
      return null;
    }
  };

  const upsertSourceCache = (source: Repository) => {
    queryClient.setQueryData<Repository[]>(queryKeys.repos.list(), (old) => {
      if (!old) return [source];
      const exists = old.some((r) => r.id === source.id);
      return exists ? old.map((r) => (r.id === source.id ? source : r)) : [source, ...old];
    });
    queryClient.invalidateQueries({ queryKey: queryKeys.repos.detail(source.id) });
  };

  const handleAnalyzeRepo = () => {
    const parsed = extractGitHubOwnerName(repoUrl);
    if (!parsed) {
      toast.add({
        title: "Invalid GitHub URL",
        description: "Please enter a valid GitHub repository URL (e.g., https://github.com/owner/repo)",
        type: "error",
      });
      return;
    }

    const canonicalUrl = `https://github.com/${parsed.owner}/${parsed.name}`;
    const slug = `${parsed.owner}-${parsed.name}`.toLowerCase();

    onOpenChange(false);
    router.push(`/chat/${slug}?url=${encodeURIComponent(canonicalUrl)}`);

    api
      .analyzeRepo(canonicalUrl)
      .then((repo) => {
        upsertSourceCache(repo);
        toast.add({
          title: "Source added",
          description: `Indexing ${repo.fullName}…`,
          type: "success",
        });
      })
      .catch((error) => {
        toast.add({
          title: "Failed to ingest source",
          description: error instanceof Error ? error.message : "Unknown error",
          type: "error",
        });
      });
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (tab !== "repo" || !repoUrl.trim()) return;
    handleAnalyzeRepo();
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90dvh] w-[calc(100vw-1.5rem)] overflow-y-auto rounded-[2px] border-border bg-card p-4 sm:max-w-md sm:p-6">
        <DialogHeader>
          <DialogTitle className="font-heading text-sm font-semibold tracking-[0.16em] uppercase">
            Initiate Source Ingest
          </DialogTitle>
          <DialogDescription className="text-xs">
            Vectorize a public GitHub repo, PDF, Jupyter notebook, IaC/CI config, or EPUB book.
          </DialogDescription>
        </DialogHeader>

        {/* 3-segment mode toggle */}
        <div
          className="grid grid-cols-3 rounded-[2px] border border-border bg-background/70 p-0.5"
          role="tablist"
          aria-label="Source type"
        >
          <button
            type="button"
            role="tab"
            aria-selected={tab === "repo"}
            onClick={() => setTab("repo")}
            className={`inline-flex items-center justify-center gap-1.5 rounded-[1px] px-2.5 py-1.5 font-mono text-[10px] font-medium tracking-[0.12em] uppercase transition-colors ${
              tab === "repo"
                ? "bg-foreground text-background"
                : "text-muted-foreground hover:text-foreground"
            }`}
          >
            <GitBranch className="size-3" />
            GitHub
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === "pdf"}
            onClick={() => setTab("pdf")}
            className={`inline-flex items-center justify-center gap-1.5 rounded-[1px] px-2.5 py-1.5 font-mono text-[10px] font-medium tracking-[0.12em] uppercase transition-colors ${
              tab === "pdf"
                ? "bg-foreground text-background"
                : "text-muted-foreground hover:text-foreground"
            }`}
          >
            <FileText className="size-3" />
            PDF
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === "devdocs"}
            onClick={() => setTab("devdocs")}
            className={`inline-flex items-center justify-center gap-1.5 rounded-[1px] px-2.5 py-1.5 font-mono text-[10px] font-medium tracking-[0.12em] uppercase transition-colors ${
              tab === "devdocs"
                ? "bg-foreground text-background"
                : "text-muted-foreground hover:text-foreground"
            }`}
          >
            <Layers className="size-3" />
            Dev Docs
          </button>
        </div>

        {tab === "repo" ? (
          <form onSubmit={handleSubmit}>
            <div className="grid gap-4 py-3">
              <div className="grid gap-2">
                <Label
                  htmlFor="repo-url"
                  className="font-mono text-[10px] tracking-[0.16em] text-muted-foreground uppercase"
                >
                  GitHub URL
                </Label>
                <div className="relative">
                  <GitBranch className="absolute left-3 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
                  <Input
                    id="repo-url"
                    type="url"
                    inputMode="url"
                    autoCapitalize="none"
                    autoCorrect="off"
                    placeholder="https://github.com/owner/repo"
                    value={repoUrl}
                    onChange={(e) => setRepoUrl(e.target.value)}
                    className="h-10 rounded-[2px] border-input bg-background pl-9 font-mono text-base placeholder:text-xs sm:text-xs"
                    required
                  />
                </div>
              </div>
            </div>

            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={!repoUrl.trim()}>
                Analyze
                <ArrowRight className="ml-1.5 size-3.5" />
              </Button>
            </DialogFooter>
          </form>
        ) : (
          <div className="space-y-3 py-1">
            {tab === "devdocs" && (
              <div className="grid grid-cols-3 gap-1.5">
                {(
                  [
                    { id: "notebook" as const, label: "Jupyter", icon: FileCode2 },
                    { id: "iac" as const, label: "IaC / CI", icon: ServerCog },
                    { id: "epub" as const, label: "EPUB", icon: BookOpen },
                  ] as const
                ).map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => setDevFormat(item.id)}
                    className={`inline-flex items-center justify-center gap-1.5 rounded-[2px] border px-2 py-1.5 font-mono text-[10px] tracking-[0.1em] uppercase transition-colors ${
                      devFormat === item.id
                        ? "border-foreground bg-foreground/10 text-foreground"
                        : "border-border text-muted-foreground hover:border-foreground/50 hover:text-foreground"
                    }`}
                  >
                    <item.icon className="size-3" />
                    {item.label}
                  </button>
                ))}
              </div>
            )}

            <FileUploadZone
              compact
              format={activeUploadFormat}
              onFormatDetected={(detected) => {
                if (detected === "pdf") {
                  setTab("pdf");
                } else {
                  setDevFormat(detected);
                  setTab("devdocs");
                }
              }}
              onUploaded={(source) => {
                upsertSourceCache(source);
                toast.add({
                  title: "Source uploaded",
                  description: `Indexing ${source.fullName}…`,
                  type: "success",
                });
                onOpenChange(false);
                router.push(`/chat/${source.id}`);
              }}
            />

            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
                Close
              </Button>
            </DialogFooter>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
