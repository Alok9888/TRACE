"use client";

import { BookOpen, ExternalLink, FileCode2, FileText, ServerCog } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { effectiveSourceType, isUploadedSource, type Citation, type Repository } from "@/lib/api";

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

  const repoType = effectiveSourceType(repo);
  const uploaded = isUploadedSource(repo);

  return (
    <div className="flex flex-wrap gap-1.5">
      {citations.map((citation, index) => {
        const citeType = (citation.sourceType as string | undefined) || repoType;
        const isDocumentCitation =
          uploaded ||
          citeType === "PDF" ||
          citeType === "EPUB" ||
          citeType === "NOTEBOOK" ||
          citeType === "IAC" ||
          (citeType !== "GITHUB_REPO" && citation.pageNumber != null);

        if (isDocumentCitation) {
          const docLabel = citation.filePath || repo.fileName || repo.fullName;
          const unitNum = citation.pageNumber ?? citation.startLine;

          if (citeType === "EPUB") {
            const chapterLabel = unitNum != null ? `Chapter ${unitNum}` : "Chapter";
            const heading = citation.sectionHeading ? ` · ${citation.sectionHeading}` : "";
            return (
              <Badge
                key={`${docLabel}-ch-${unitNum ?? index}-${index}`}
                variant="outline"
                title={`${docLabel} — ${chapterLabel}${heading}`}
                className="max-w-full gap-1.5 rounded-[2px] border-border bg-card px-2 py-0.5 font-mono text-[10px] font-normal tracking-[0.04em] text-muted-foreground transition-colors hover:border-foreground/60 hover:text-foreground"
              >
                <BookOpen className="size-2.5 shrink-0 opacity-75" />
                <span className="truncate">
                  {chapterLabel}
                  {heading}
                </span>
              </Badge>
            );
          }

          if (citeType === "NOTEBOOK") {
            const cellLabel = unitNum != null ? `Cell ${unitNum}` : "Cell";
            const heading = citation.sectionHeading ? ` · ${citation.sectionHeading}` : "";
            return (
              <Badge
                key={`${docLabel}-cell-${unitNum ?? index}-${index}`}
                variant="outline"
                title={`${docLabel} — ${cellLabel}${heading}`}
                className="max-w-full gap-1.5 rounded-[2px] border-border bg-card px-2 py-0.5 font-mono text-[10px] font-normal tracking-[0.04em] text-muted-foreground transition-colors hover:border-foreground/60 hover:text-foreground"
              >
                <FileCode2 className="size-2.5 shrink-0 opacity-75" />
                <span className="truncate">
                  {cellLabel}
                  {heading}
                </span>
              </Badge>
            );
          }

          if (citeType === "IAC") {
            const blockLabel = citation.sectionHeading
              ? `Block: ${citation.sectionHeading}`
              : docLabel;
            const lineSuffix = unitNum != null ? ` (L${unitNum})` : "";
            return (
              <Badge
                key={`${docLabel}-iac-${unitNum ?? index}-${index}`}
                variant="outline"
                title={`${docLabel} — ${blockLabel}${lineSuffix}`}
                className="max-w-full gap-1.5 rounded-[2px] border-border bg-card px-2 py-0.5 font-mono text-[10px] font-normal tracking-[0.04em] text-muted-foreground transition-colors hover:border-foreground/60 hover:text-foreground"
              >
                <ServerCog className="size-2.5 shrink-0 opacity-75" />
                <span className="truncate">
                  {blockLabel}
                  {lineSuffix}
                </span>
              </Badge>
            );
          }

          const pageLabel = unitNum != null ? `Page ${unitNum}` : "Document";
          const headingLabel = citation.sectionHeading ? ` · ${citation.sectionHeading}` : "";
          return (
            <Badge
              key={`${docLabel}-pg-${unitNum ?? index}-${index}`}
              variant="outline"
              title={`${docLabel} — ${pageLabel}${headingLabel}`}
              className="max-w-full gap-1.5 rounded-[2px] border-border bg-card px-2 py-0.5 font-mono text-[10px] font-normal tracking-[0.04em] text-muted-foreground transition-colors hover:border-foreground/60 hover:text-foreground"
            >
              <FileText className="size-2.5 shrink-0 opacity-75" />
              <span className="truncate">
                {docLabel} · {pageLabel}
                {headingLabel}
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
              {citation.sectionHeading ? ` · ${citation.sectionHeading}` : ""}
            </span>
            <ExternalLink className="size-2.5 opacity-60" />
          </Badge>
        );
      })}
    </div>
  );
}
