import type { IndexStatus, Repository } from "@/lib/api";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

export function indexStatusLabel(status: IndexStatus) {
  switch (status) {
    case "READY":
      return "ONLINE";
    case "INDEXING":
      return "SYNCING";
    case "FAILED":
      return "FAULT";
    default:
      return "STANDBY";
  }
}

export function IndexStatusBadge({
  status,
  className,
}: {
  status: IndexStatus;
  className?: string;
}) {
  const tone =
    status === "READY"
      ? "border-foreground/35 bg-foreground/[0.06] text-foreground"
      : status === "FAILED"
        ? "border-destructive/50 bg-destructive/10 text-destructive"
        : status === "INDEXING"
          ? "border-foreground/45 bg-transparent text-foreground"
          : "border-border bg-transparent text-muted-foreground";

  return (
    <Badge
      variant="outline"
      className={cn(
        "rounded-[2px] px-2 py-0.5 font-mono text-[10px] font-medium uppercase tracking-[0.14em]",
        tone,
        className
      )}
    >
      {status === "READY" && (
        <span className="mr-1.5 size-1.5 rounded-full bg-foreground" />
      )}
      {status === "INDEXING" && (
        <span className="mr-1.5 size-1.5 animate-pulse rounded-full bg-foreground" />
      )}
      {status === "FAILED" && (
        <span className="mr-1.5 size-1.5 rounded-full bg-destructive" />
      )}
      {indexStatusLabel(status)}
    </Badge>
  );
}

export function languageColor(language: string | null) {
  return language ? "bg-foreground/70" : "bg-muted-foreground/50";
}

export function RepoMeta({ repo }: { repo: Repository }) {
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
      {repo.language && (
        <span className="inline-flex items-center gap-1.5">
          <span
            className={cn("size-2 rounded-full", languageColor(repo.language))}
          />
          {repo.language}
        </span>
      )}
      <span>{repo.defaultBranch}</span>
      {repo.chunkCount > 0 && <span>{repo.chunkCount.toLocaleString()} chunks</span>}
    </div>
  );
}
