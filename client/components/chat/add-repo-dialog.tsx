"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowRight, FileText, GitBranch } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";

import { PdfUploadZone } from "@/components/landing/pdf-upload-zone";
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

export function AddRepoDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const [mode, setMode] = useState<"repo" | "pdf">("repo");
  const [repoUrl, setRepoUrl] = useState("");

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
    if (mode !== "repo" || !repoUrl.trim()) return;
    handleAnalyzeRepo();
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="rounded-[2px] border-border bg-card sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="font-heading text-sm font-semibold tracking-[0.16em] uppercase">
            Initiate Source Ingest
          </DialogTitle>
          <DialogDescription className="text-xs">
            Vectorize a public GitHub repository or upload a PDF document to open a grounded comms channel.
          </DialogDescription>
        </DialogHeader>

        {/* Source mode toggle */}
        <div
          className="grid grid-cols-2 rounded-[2px] border border-border bg-background/70 p-0.5"
          role="tablist"
          aria-label="Source type"
        >
          <button
            type="button"
            role="tab"
            aria-selected={mode === "repo"}
            onClick={() => setMode("repo")}
            className={`inline-flex items-center justify-center gap-1.5 rounded-[1px] px-3 py-1.5 font-mono text-[10px] font-medium tracking-[0.14em] uppercase transition-colors ${
              mode === "repo"
                ? "bg-foreground text-background"
                : "text-muted-foreground hover:text-foreground"
            }`}
          >
            <GitBranch className="size-3" />
            GitHub Repo
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={mode === "pdf"}
            onClick={() => setMode("pdf")}
            className={`inline-flex items-center justify-center gap-1.5 rounded-[1px] px-3 py-1.5 font-mono text-[10px] font-medium tracking-[0.14em] uppercase transition-colors ${
              mode === "pdf"
                ? "bg-foreground text-background"
                : "text-muted-foreground hover:text-foreground"
            }`}
          >
            <FileText className="size-3" />
            PDF Document
          </button>
        </div>

        {mode === "repo" ? (
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
                    placeholder="https://github.com/owner/repo"
                    value={repoUrl}
                    onChange={(e) => setRepoUrl(e.target.value)}
                    className="h-10 rounded-[2px] border-input bg-background pl-9 font-mono text-xs"
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
          <div className="space-y-4 py-2">
            <PdfUploadZone
              compact
              onUploaded={(source) => {
                upsertSourceCache(source);
                toast.add({
                  title: "PDF uploaded",
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
