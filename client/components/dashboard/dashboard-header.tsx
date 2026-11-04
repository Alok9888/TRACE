"use client";

import { RefreshCw, Search } from "lucide-react";

import { ModeToggle } from "@/components/ui/mode-toggle";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";
import { SidebarTrigger } from "@/components/ui/sidebar";
import { cn } from "@/lib/utils";
import type { IndexStatus } from "@/lib/api";

type FilterStatus = "ALL" | IndexStatus;

type DashboardHeaderProps = {
  search: string;
  onSearchChange: (value: string) => void;
  visibility: "all" | "public" | "private";
  onVisibilityChange: (value: "all" | "public" | "private") => void;
  status: FilterStatus;
  onStatusChange: (value: FilterStatus) => void;
  totalCount?: number;
  readyCount?: number;
  onSync: () => void;
  isSyncing?: boolean;
};

const visibilityFilters = [
  { value: "all" as const, label: "All" },
  { value: "public" as const, label: "Public" },
  { value: "private" as const, label: "Private" },
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
  visibility,
  onVisibilityChange,
  status,
  onStatusChange,
  totalCount,
  readyCount,
  onSync,
  isSyncing,
}: DashboardHeaderProps) {
  return (
    <div className="sticky top-0 z-20 border-b border-border bg-background/90 backdrop-blur-md">
      <div className="flex flex-col gap-4 px-5 py-4 md:px-6">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
          <div className="flex min-w-0 items-start gap-3">
            <SidebarTrigger className="-ml-1 mt-0.5" />
            <div className="min-w-0">
              <h1 className="font-heading text-lg font-semibold tracking-[0.14em] uppercase">
                Repositories
              </h1>
              <p className="tabular-telemetry font-mono text-[11px] tracking-[0.12em] text-muted-foreground uppercase">
                {totalCount != null
                  ? `${totalCount} TRACKED // ${readyCount ?? 0} ONLINE`
                  : "SYNC AND INDEX A REPOSITORY TO INITIATE TELEMETRY"}
              </p>
            </div>
          </div>

          <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
            <div className="relative min-w-[220px] flex-1 sm:min-w-[280px]">
              <Search className="pointer-events-none absolute top-1/2 left-3 size-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={search}
                onChange={(e) => onSearchChange(e.target.value)}
                placeholder="Filter repositories..."
                className="h-9 rounded-[2px] border-input bg-card pl-9 font-mono text-xs"
              />
            </div>
            <div className="flex items-center gap-2">
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

        <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="mr-2 font-mono text-[10px] tracking-[0.18em] text-muted-foreground uppercase">
              Scope
            </span>
            {visibilityFilters.map((filter) => (
              <FilterPill
                key={filter.value}
                active={visibility === filter.value}
                onClick={() => onVisibilityChange(filter.value)}
              >
                {filter.label}
              </FilterPill>
            ))}
          </div>

          <div className="flex flex-wrap items-center gap-1.5">
            <span className="mr-2 font-mono text-[10px] tracking-[0.18em] text-muted-foreground uppercase">
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
