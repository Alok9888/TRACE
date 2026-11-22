"use client";

import { ExternalLink, FileText } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { isPdfSource, type Citation, type Repository } from "@/lib/api";

export function citationHref(repo: Repository, citation: Citation) {
  const line =
    citation.startLine != null
      ? `#L${citation.startLine}${
          citation.endLine && citation.endLine !== citation.startLine
            ? `-L${citation.endLine}`
            : ""
        }`
      : "";
  return `https://github.com/${repo.fullName}/blob/${repo.defaultBranch}/${citation.filePath}${line}`;
}

export function CitationChips({
  repo,
  citations,
}: {
  repo: Repository;
  citations: Citation[];
}) {
  if (!citations.length) return null;

  const pdfMode = isPdfSource(repo);

  return (
    <div className="flex flex-wrap gap-1.5">
      {citations.map((citation, index) => {
        const isPdfCitation =
          pdfMode ||
          citation.sourceType === "PDF" ||
          citation.pageNumber != null;

        if (isPdfCitation) {
          const docLabel = citation.filePath || repo.fileName || repo.fullName;
          const pageLabel =
            citation.pageNumber != null ? `Page ${citation.pageNumber}` : "Document";
          const headingLabel = citation.sectionHeading
            ? ` · ${citation.sectionHeading}`
            : "";

          return (
            <Badge
              key={`${docLabel}-${citation.pageNumber ?? index}-${index}`}
              variant="outline"
              title={`${docLabel} — ${pageLabel}${headingLabel}`}
              className="max-w-full gap-1.5 rounded-[2px] border-border bg-card px-2 py-0.5 font-mono text-[10px] font-normal tracking-[0.04em] text-muted-foreground"
            >
              <FileText className="size-2.5 shrink-0 opacity-70" />
              <span className="truncate">
                {docLabel} · {pageLabel}
                {citation.sectionHeading ? ` · ${citation.sectionHeading}` : ""}
              </span>
            </Badge>
          );
        }

        return (
          <Badge
            key={`${citation.filePath}-${index}`}
            variant="outline"
            render={
              <a
                href={citationHref(repo, citation)}
                target="_blank"
                rel="noreferrer"
              />
            }
            className="max-w-full gap-1.5 rounded-[2px] border-border bg-card px-2 py-0.5 font-mono text-[10px] font-normal tracking-[0.04em] text-muted-foreground transition-colors hover:border-foreground hover:bg-foreground hover:text-background"
          >
            <span className="truncate">
              {citation.filePath}
              {citation.startLine != null ? `:${citation.startLine}` : ""}
            </span>
            <ExternalLink className="size-2.5 opacity-60" />
          </Badge>
        );
      })}
    </div>
  );
}
