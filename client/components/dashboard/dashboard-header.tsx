"use client";

import { RefreshCw, Search } from "lucide-react";

import { ModeToggle } from "@/components/ui/mode-toggle";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";
import { SidebarTrigger } from "@/components/ui/sidebar";
import { cn } from "@/lib/utils";
import type { IndexStatus, SourceType } from "@/lib/api";

type FilterStatus = "ALL" | IndexStatus;
type FilterSourceType = "ALL" | SourceType;

type DashboardHeaderProps = {
  search: string;
  onSearchChange: (value: string) => void;
  sourceFilter: FilterSourceType;
  onSourceFilterChange: (value: FilterSourceType) => void;
  status: FilterStatus;
  onStatusChange: (value: FilterStatus) => void;
  totalCount?: number;
  readyCount?: number;
  onSync: () => void;
  isSyncing?: boolean;
};

const sourceTypeFilters: { value: FilterSourceType; label: string }[] = [
  { value: "ALL", label: "All" },
  { value: "GITHUB_REPO", label: "GitHub" },
  { value: "PDF", label: "PDF" },
  { value: "NOTEBOOK", label: "Notebook" },
  { value: "IAC", label: "IaC" },
  { value: "EPUB", label: "EPUB" },
];

const statusFilters: { value: FilterStatus; label: string }[] = [
  { value: "ALL", label: "All" },
  { value: "READY", label: "Ready" },
  { value: "INDEXING", label: "Indexing" },
  { value: "PENDING", label: "New" },
  { value: "FAILED", label: "Failed" },
];

function FilterPill({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "rounded-[2px] border px-2.5 py-1 font-mono text-[10px] font-medium tracking-[0.14em] uppercase transition-colors",
        active
          ? "border-foreground bg-foreground text-background"
          : "border-border bg-transparent text-muted-foreground hover:border-foreground/40 hover:text-foreground"
      )}
    >
      {children}
    </button>
  );
}

export function DashboardHeader({
  search,
  onSearchChange,
  sourceFilter,
  onSourceFilterChange,
  status,
  onStatusChange,
  totalCount,
  readyCount,
  onSync,
  isSyncing,
}: DashboardHeaderProps) {
  return (
    <div className="sticky top-0 z-20 border-b border-border bg-background/90 backdrop-blur-md">
      <div className="flex flex-col gap-3 px-4 py-3 sm:gap-4 sm:px-5 sm:py-4 md:px-6">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex min-w-0 items-center justify-between gap-3">
            <div className="flex min-w-0 items-center gap-2.5">
              <SidebarTrigger className="-ml-1" />
              <div className="min-w-0">
                <h1 className="truncate font-heading text-base font-semibold tracking-[0.14em] uppercase sm:text-lg">
                  Sources
                </h1>
                <p className="tabular-telemetry truncate font-mono text-[10px] tracking-[0.12em] text-muted-foreground uppercase sm:text-[11px]">
                  {totalCount != null
                    ? `${totalCount} TRACKED // ${readyCount ?? 0} ONLINE`
                    : "INDEX A SOURCE TO INITIATE TELEMETRY"}
                </p>
              </div>
            </div>

            <div className="flex items-center gap-1.5 sm:hidden">
              <Button
                variant="outline"
                size="sm"
                onClick={onSync}
                disabled={isSyncing}
              >
                <RefreshCw
                  data-icon="inline-start"
                  className={isSyncing ? "animate-spin" : undefined}
                />
                Sync
              </Button>
              <ModeToggle />
            </div>
          </div>

          <div className="flex items-center gap-2">
            <div className="relative min-w-0 flex-1 sm:min-w-[260px]">
              <Search className="pointer-events-none absolute top-1/2 left-3 size-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={search}
                onChange={(e) => onSearchChange(e.target.value)}
                placeholder="Filter indexed sources..."
                className="h-8 rounded-[2px] border-input bg-card pl-9 font-mono text-xs sm:h-9"
              />
            </div>
            <div className="hidden items-center gap-2 sm:flex">
              <Button
                variant="outline"
                onClick={onSync}
                disabled={isSyncing}
              >
                <RefreshCw
                  data-icon="inline-start"
                  className={isSyncing ? "animate-spin" : undefined}
                />
                Sync
              </Button>
              <ModeToggle />
            </div>
          </div>
        </div>

        <Separator className="opacity-60" />

        <div className="no-scrollbar flex items-center justify-between gap-4 overflow-x-auto pb-0.5">
          <div className="flex shrink-0 items-center gap-1.5">
            <span className="mr-1 font-mono text-[10px] tracking-[0.18em] text-muted-foreground uppercase">
              Type
            </span>
            {sourceTypeFilters.map((filter) => (
              <FilterPill
                key={filter.value}
                active={sourceFilter === filter.value}
                onClick={() => onSourceFilterChange(filter.value)}
              >
                {filter.label}
              </FilterPill>
            ))}
          </div>

          <div className="flex shrink-0 items-center gap-1.5">
            <span className="mr-1 font-mono text-[10px] tracking-[0.18em] text-muted-foreground uppercase">
              State
            </span>
            {statusFilters.map((filter) => (
              <FilterPill
                key={filter.value}
                active={status === filter.value}
                onClick={() => onStatusChange(filter.value)}
              >
                {filter.label}
              </FilterPill>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
