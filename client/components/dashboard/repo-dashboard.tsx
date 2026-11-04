"use client";

import { useMemo, useState } from "react";
import { FolderGit2 } from "lucide-react";

import { DashboardHeader } from "@/components/dashboard/dashboard-header";
import { RepoCard } from "@/components/dashboard/repo-card";
import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { Skeleton } from "@/components/ui/skeleton";
import { useRefreshRepos, useRepos } from "@/hooks/use-repos";
import type { IndexStatus } from "@/lib/api";

type FilterStatus = "ALL" | IndexStatus;

export function RepoDashboard() {
  const reposQuery = useRepos();
  const refresh = useRefreshRepos();
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState<FilterStatus>("ALL");
  const [visibility, setVisibility] = useState<"all" | "public" | "private">(
    "all"
  );

  const filtered = useMemo(() => {
    const list = reposQuery.data ?? [];
    const q = search.trim().toLowerCase();

    return list.filter((repo) => {
      if (status !== "ALL" && repo.indexStatus !== status) return false;
      if (visibility === "private" && !repo.isPrivate) return false;
      if (visibility === "public" && repo.isPrivate) return false;
      if (!q) return true;
      return (
        repo.fullName.toLowerCase().includes(q) ||
        (repo.description ?? "").toLowerCase().includes(q) ||
        (repo.language ?? "").toLowerCase().includes(q)
      );
    });
  }, [reposQuery.data, search, status, visibility]);

  const readyCount =
    reposQuery.data?.filter((r) => r.indexStatus === "READY").length ?? 0;

  return (
    <div className="relative flex min-h-full flex-col overflow-hidden">
      {/* Subtle monochrome planetary silhouette watermark in dark void */}
      <img
        src="/images/earth-dark.jpg"
        alt=""
        aria-hidden="true"
        className="pointer-events-none fixed right-0 bottom-0 z-0 h-[460px] w-[460px] object-contain opacity-[0.06] select-none dark:opacity-[0.11]"
      />
      <DashboardHeader
        search={search}
        onSearchChange={setSearch}
        visibility={visibility}
        onVisibilityChange={setVisibility}
        status={status}
        onStatusChange={setStatus}
        totalCount={reposQuery.data?.length}
        readyCount={readyCount}
        onSync={() => refresh.mutate()}
        isSyncing={refresh.isPending || reposQuery.isFetching}
      />

      <div className="relative z-10 flex flex-1 flex-col gap-4 p-5 md:p-6">
        {reposQuery.isLoading && (
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            {Array.from({ length: 6 }).map((_, i) => (
              <Skeleton key={i} className="h-56 rounded-[2px]" />
            ))}
          </div>
        )}

        {reposQuery.isError && (
          <Empty className="rounded-[2px] border border-border">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <FolderGit2 />
              </EmptyMedia>
              <EmptyTitle className="font-heading tracking-[0.1em] uppercase">
                Telemetry Unavailable
              </EmptyTitle>
              <EmptyDescription>
                {(reposQuery.error as Error).message}
              </EmptyDescription>
            </EmptyHeader>
            <Button onClick={() => void reposQuery.refetch()}>Retry</Button>
          </Empty>
        )}

        {reposQuery.isSuccess && filtered.length === 0 && (
          <Empty className="rounded-[2px] border border-border">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <FolderGit2 />
              </EmptyMedia>
              <EmptyTitle className="font-heading tracking-[0.1em] uppercase">
                No Matching Repositories
              </EmptyTitle>
              <EmptyDescription>
                Adjust active filters or add a repository from the sidebar.
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        )}

        {reposQuery.isSuccess && filtered.length > 0 && (
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            {filtered.map((repo) => (
              <RepoCard key={repo.id} repo={repo} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
