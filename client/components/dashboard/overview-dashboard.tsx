"use client";

import Link from "next/link";
import { useMemo } from "react";
import {
  AlertCircle,
  CheckCircle2,
  Layers,
  LoaderCircle,
  MessageSquareCode,
} from "lucide-react";

import { RepoCard } from "@/components/dashboard/repo-card";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { useRepos } from "@/hooks/use-repos";

function StatCard({
  label,
  value,
  hint,
  icon: Icon,
}: {
  label: string;
  value: string | number;
  hint?: string;
  icon: typeof Layers;
}) {
  return (
    <Card size="sm">
      <CardHeader className="pb-0">
        <div className="flex items-start justify-between gap-3">
          <div>
            <CardDescription className="font-mono text-[10px] tracking-[0.18em] uppercase">
              {label}
            </CardDescription>
            <CardTitle className="tabular-telemetry mt-2 font-heading text-2xl font-semibold tracking-tight sm:text-3xl">
              {value}
            </CardTitle>
          </div>
          <div className="border border-border p-2 text-muted-foreground">
            <Icon className="size-3.5" />
          </div>
        </div>
      </CardHeader>
      {hint ? (
        <CardContent className="pt-0 font-mono text-[10px] tracking-[0.1em] text-muted-foreground uppercase">
          {hint}
        </CardContent>
      ) : null}
    </Card>
  );
}

export function OverviewDashboard() {
  const reposQuery = useRepos();
  const repos = reposQuery.data ?? [];

  const { readyCount, indexingCount, failedCount, pendingCount, totalChunks, recentRepos } =
    useMemo(() => {
      let ready = 0;
      let indexing = 0;
      let failed = 0;
      let pending = 0;
      let chunks = 0;
      for (const repo of repos) {
        chunks += repo.chunkCount;
        if (repo.indexStatus === "READY") ready++;
        else if (repo.indexStatus === "INDEXING") indexing++;
        else if (repo.indexStatus === "FAILED") failed++;
        else if (repo.indexStatus === "PENDING") pending++;
      }
      const recent = [...repos]
        .sort((a, b) => {
          const aTime = a.indexedAt ? Date.parse(a.indexedAt) : 0;
          const bTime = b.indexedAt ? Date.parse(b.indexedAt) : 0;
          return bTime - aTime;
        })
        .slice(0, 3);
      return {
        readyCount: ready,
        indexingCount: indexing,
        failedCount: failed,
        pendingCount: pending,
        totalChunks: chunks,
        recentRepos: recent,
      };
    }, [repos]);

  return (
    <div className="flex flex-1 flex-col gap-6 p-4 md:p-6">
      <div className="grid grid-cols-2 gap-3 sm:gap-4 xl:grid-cols-4">
        {reposQuery.isLoading ? (
          Array.from({ length: 4 }).map((_, index) => (
            <Skeleton key={index} className="h-24 rounded-[2px] sm:h-28" />
          ))
        ) : (
          <>
            <StatCard
              label="Sources"
              value={repos.length}
              hint="Repos, PDF, Notebook, IaC & EPUB"
              icon={Layers}
            />
            <StatCard
              label="Ready to chat"
              value={readyCount}
              hint={`${indexingCount} currently indexing`}
              icon={CheckCircle2}
            />
            <StatCard
              label="Indexed chunks"
              value={totalChunks.toLocaleString()}
              hint="Searchable vector segments"
              icon={MessageSquareCode}
            />
            <StatCard
              label="Needs attention"
              value={failedCount}
              hint={failedCount > 0 ? "Review failed indexing jobs" : "All sources healthy"}
              icon={failedCount > 0 ? AlertCircle : LoaderCircle}
            />
          </>
        )}
      </div>

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
        <section className="space-y-4">
          <div className="flex items-center justify-between gap-3">
            <div>
              <h2 className="font-heading text-sm font-semibold tracking-[0.16em] uppercase">
                Recent Sources
              </h2>
              <p className="font-mono text-[11px] tracking-[0.06em] text-muted-foreground">
                Latest indexed targets ready for interrogation.
              </p>
            </div>
            <Link
              href="/dashboard"
              className="font-mono text-[11px] tracking-[0.14em] text-muted-foreground uppercase transition-colors hover:text-foreground"
            >
              View All →
            </Link>
          </div>

          {reposQuery.isLoading ? (
            <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-1 2xl:grid-cols-2">
              {Array.from({ length: 2 }).map((_, index) => (
                <Skeleton key={index} className="h-44 rounded-2xl" />
              ))}
            </div>
          ) : recentRepos.length > 0 ? (
            <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-1 2xl:grid-cols-2">
              {recentRepos.map((repo) => (
                <RepoCard key={repo.id} repo={repo} />
              ))}
            </div>
          ) : (
            <Card>
              <CardHeader>
                <CardTitle>No indexed sources yet</CardTitle>
                <CardDescription>
                  Add a public GitHub repository or upload a PDF document to start indexing and querying your context.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <Link
                  href="/dashboard"
                  className="text-sm font-medium text-primary hover:underline"
                >
                  Go to sources
                </Link>
              </CardContent>
            </Card>
          )}
        </section>

        <section className="space-y-4">
          <div>
            <h2 className="font-heading text-sm font-semibold tracking-[0.16em] uppercase">
              System Status
            </h2>
            <p className="font-mono text-[11px] tracking-[0.06em] text-muted-foreground">
              Real-time indexing telemetry across workspace.
            </p>
          </div>

          <Card>
            <CardContent className="space-y-3.5 pt-5 font-mono text-xs">
              {reposQuery.isLoading ? (
                Array.from({ length: 4 }).map((_, index) => (
                  <Skeleton key={index} className="h-7 rounded-[2px]" />
                ))
              ) : (
                <>
                  <div className="flex items-center justify-between gap-3 border-b border-border/60 pb-2.5">
                    <span className="tracking-[0.14em] text-muted-foreground uppercase">Online</span>
                    <Badge variant="outline" className="tabular-telemetry rounded-[2px] font-mono text-[11px]">{readyCount}</Badge>
                  </div>
                  <div className="flex items-center justify-between gap-3 border-b border-border/60 pb-2.5">
                    <span className="tracking-[0.14em] text-muted-foreground uppercase">Syncing</span>
                    <Badge variant="outline" className="tabular-telemetry rounded-[2px] font-mono text-[11px]">{indexingCount}</Badge>
                  </div>
                  <div className="flex items-center justify-between gap-3 border-b border-border/60 pb-2.5">
                    <span className="tracking-[0.14em] text-muted-foreground uppercase">Standby</span>
                    <Badge variant="outline" className="tabular-telemetry rounded-[2px] font-mono text-[11px]">{pendingCount}</Badge>
                  </div>
                  <div className="flex items-center justify-between gap-3">
                    <span className="tracking-[0.14em] text-muted-foreground uppercase">Fault</span>
                    <Badge variant={failedCount > 0 ? "destructive" : "outline"} className="tabular-telemetry rounded-[2px] font-mono text-[11px]">
                      {failedCount}
                    </Badge>
                  </div>
                </>
              )}
            </CardContent>
          </Card>
        </section>
      </div>
    </div>
  );
}
