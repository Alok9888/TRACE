"use client";

import { FileUploadZone } from "@/components/landing/file-upload-zone";
import type { Repository } from "@/lib/api";

export function PdfUploadZone({
  onUploaded,
  compact = false,
  className,
}: {
  onUploaded: (source: Repository) => void;
  compact?: boolean;
  className?: string;
}) {
  return (
    <FileUploadZone
      format="pdf"
      onUploaded={onUploaded}
      compact={compact}
      className={className}
    />
  );
}
