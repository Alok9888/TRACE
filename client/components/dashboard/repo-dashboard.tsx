"use client";

import { useMemo, useState } from "react";
import { Layers } from "lucide-react";

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
import type { IndexStatus, SourceType } from "@/lib/api";

type FilterStatus = "ALL" | IndexStatus;
type FilterSourceType = "ALL" | SourceType;

export function RepoDashboard() {
  const reposQuery = useRepos();
  const refresh = useRefreshRepos();
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState<FilterStatus>("ALL");
  const [sourceFilter, setSourceFilter] = useState<FilterSourceType>("ALL");

  const filtered = useMemo(() => {
    const list = reposQuery.data ?? [];
    const q = search.trim().toLowerCase();

    return list.filter((repo) => {
      const effectiveType: SourceType = repo.sourceType ?? "GITHUB_REPO";
      if (status !== "ALL" && repo.indexStatus !== status) return false;
      if (sourceFilter !== "ALL" && effectiveType !== sourceFilter) return false;
      if (!q) return true;
      return (
        repo.fullName.toLowerCase().includes(q) ||
        (repo.fileName ?? "").toLowerCase().includes(q) ||
        (repo.description ?? "").toLowerCase().includes(q) ||
        (repo.language ?? "").toLowerCase().includes(q)
      );
    });
  }, [reposQuery.data, search, status, sourceFilter]);

  const readyCount =
    reposQuery.data?.filter((r) => r.indexStatus === "READY").length ?? 0;

  return (
    <div className="relative flex min-h-full flex-col overflow-hidden">
      <img
        src="/images/earth-dark.jpg"
        alt=""
        aria-hidden="true"
        className="pointer-events-none fixed right-0 bottom-0 z-0 h-[460px] w-[460px] object-contain opacity-[0.06] select-none dark:opacity-[0.11]"
      />
      <DashboardHeader
        search={search}
        onSearchChange={setSearch}
        sourceFilter={sourceFilter}
        onSourceFilterChange={setSourceFilter}
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
                <Layers />
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
                <Layers />
              </EmptyMedia>
              <EmptyTitle className="font-heading tracking-[0.1em] uppercase">
                No Matching Sources
              </EmptyTitle>
              <EmptyDescription>
                Adjust active filters or add a GitHub repository or PDF from the sidebar.
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
