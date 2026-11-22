import { BookOpen, FileCode2, FileText, GitBranch, ServerCog } from "lucide-react";

import type { SourceType } from "@/lib/api";

export function SourceTypeIcon({
  sourceType,
  className = "size-3.5",
}: {
  sourceType?: SourceType | string | null;
  className?: string;
}) {
  switch (sourceType) {
    case "PDF":
      return <FileText className={className} />;
    case "NOTEBOOK":
      return <FileCode2 className={className} />;
    case "IAC":
      return <ServerCog className={className} />;
    case "EPUB":
      return <BookOpen className={className} />;
    default:
      return <GitBranch className={className} />;
  }
}
