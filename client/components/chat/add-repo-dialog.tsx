"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { GitBranch, ArrowRight } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { api, type Repository } from "@/lib/api";
import { useQueryClient } from "@tanstack/react-query";
import { queryKeys } from "@/lib/query-keys";
import { toast } from "@/components/ui/toast";

export function AddRepoDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const [repoUrl, setRepoUrl] = useState("");

  const extractGitHubOwnerName = (url: string): { owner: string; name: string } | null => {
    try {
      const match = url.match(/github\.com\/([^/]+)\/([^/]+)/);
      if (match) {
        return { owner: match[1], name: match[2].replace(/\.git$/, "") };
      }
      return null;
    } catch {
      return null;
    }
  };

  const handleAnalyze = () => {
    const parsed = extractGitHubOwnerName(repoUrl);
    if (!parsed) {
      toast.add({
        title: "Invalid GitHub URL",
        description: "Please enter a valid GitHub repository URL (e.g., https://github.com/owner/repo)",
        type: "error",
      });
      return;
    }

    // Create slug from owner-name (hyphen, not slash) for immediate navigation
    const slug = `${parsed.owner}-${parsed.name}`.toLowerCase();

    // Navigate to chat page IMMEDIATELY - no await
    router.push(`/chat/${slug}?url=${encodeURIComponent(repoUrl)}`);

    // Fire POST /api/analyze in background
    api.analyzeRepo(repoUrl).then(repo => {
      // Update cache when done
      queryClient.setQueryData<Repository[]>(queryKeys.repos.list(), (old) => {
        if (!old) return [repo];
        const exists = old.find(r => r.id === repo.id);
        if (exists) return old;
        return [...old, repo];
      });
      queryClient.invalidateQueries({ queryKey: queryKeys.repos.detail(repo.id) });
      toast.add({ title: "Repository added!", description: `Analyzing ${repo.fullName}...`, type: "success" });
    }).catch(error => {
      toast.add({ title: "Failed to analyze repository", description: error instanceof Error ? error.message : "Unknown error", type: "error" });
    });
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!repoUrl.trim()) return;
    handleAnalyze();
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="rounded-[2px] border-border bg-card sm:max-w-md">
        <form onSubmit={handleSubmit}>
          <DialogHeader>
            <DialogTitle className="font-heading text-sm font-semibold tracking-[0.16em] uppercase">
              Initiate Repository Ingest
            </DialogTitle>
            <DialogDescription className="text-xs">
              Supply a public GitHub URL to vectorize its source tree and open a comms channel.
            </DialogDescription>
          </DialogHeader>

          <div className="grid gap-4 py-5">
            <div className="grid gap-2">
              <Label
                htmlFor="repo-url"
                className="font-mono text-[10px] tracking-[0.16em] text-muted-foreground uppercase"
              >
                GitHub Repository URL
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
      </DialogContent>
    </Dialog>
  );
}