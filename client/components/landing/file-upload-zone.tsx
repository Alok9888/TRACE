"use client";

import { useCallback, useRef, useState, type DragEvent } from "react";
import {
  ArrowRight,
  BookOpen,
  FileCode2,
  FileText,
  Loader2,
  RefreshCw,
  ServerCog,
  Upload,
  X,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { api, formatFileSize, type Repository } from "@/lib/api";
import { cn } from "@/lib/utils";

export const MAX_FILE_UPLOAD_BYTES = 20 * 1024 * 1024; // 20 MB

export type UploadFormat = "pdf" | "notebook" | "iac" | "epub";

export const UPLOAD_FORMAT_SPECS: Record<
  UploadFormat,
  {
    shortTag: string;
    label: string;
    dropPrompt: string;
    accept: string;
    acceptHint: string;
    citationHint: string;
    ctaLabel: string;
  }
> = {
  pdf: {
    shortTag: "PDF",
    label: "PDF Document",
    dropPrompt: "Drop a PDF here or click to browse",
    accept: ".pdf,application/pdf",
    acceptHint: "Accepts .pdf up to 20 MB",
    citationHint: "PAGE-PRESERVING CITATIONS",
    ctaLabel: "Index PDF",
  },
  notebook: {
    shortTag: "IPYNB",
    label: "Jupyter Notebook",
    dropPrompt: "Drop a .ipynb notebook here or click to browse",
    accept: ".ipynb,application/x-ipynb+json,application/json",
    acceptHint: "Accepts .ipynb up to 20 MB",
    citationHint: "CELL-PAIRED · PLOTS STRIPPED",
    ctaLabel: "Index Notebook",
  },
  iac: {
    shortTag: "IAC",
    label: "IaC & CI/CD Config",
    dropPrompt: "Drop .tf, Dockerfile, or .yml/.yaml here or click to browse",
    accept: ".tf,.dockerfile,.yml,.yaml,text/plain,text/yaml,application/x-yaml",
    acceptHint: "Accepts .tf, Dockerfile, .yml/.yaml up to 20 MB",
    citationHint: "BLOCK & STAGE CITATIONS",
    ctaLabel: "Index Config",
  },
  epub: {
    shortTag: "EPUB",
    label: "EPUB Technical Book",
    dropPrompt: "Drop an .epub book or spec here or click to browse",
    accept: ".epub,application/epub+zip",
    acceptHint: "Accepts .epub up to 20 MB",
    citationHint: "CHAPTER-INDEXED CITATIONS",
    ctaLabel: "Index EPUB",
  },
};

export function detectUploadFormat(file: File): UploadFormat | null {
  const lowerName = file.name.toLowerCase();
  const baseName = lowerName.slice(lowerName.lastIndexOf("/") + 1);
  const type = (file.type || "").toLowerCase();

  if (baseName.endsWith(".pdf") || type.includes("pdf")) {
    return "pdf";
  }
  if (baseName.endsWith(".ipynb") || type.includes("ipynb")) {
    return "notebook";
  }
  if (baseName.endsWith(".epub") || type.includes("epub")) {
    return "epub";
  }
  if (
    baseName.endsWith(".tf") ||
    baseName === "dockerfile" ||
    baseName.endsWith(".dockerfile") ||
    baseName.startsWith("dockerfile.") ||
    baseName.endsWith(".yml") ||
    baseName.endsWith(".yaml")
  ) {
    return "iac";
  }
  return null;
}

export function validateUploadFile(file: File): { format: UploadFormat | null; error: string | null } {
  const detected = detectUploadFormat(file);
  if (!detected) {
    return {
      format: null,
      error: "Unsupported file. Drop a .pdf, .ipynb, .epub, .tf, Dockerfile, or .yml/.yaml file.",
    };
  }
  if (file.size <= 0) {
    return { format: detected, error: "Selected file is empty." };
  }
  if (file.size > MAX_FILE_UPLOAD_BYTES) {
    return {
      format: detected,
      error: `File exceeds 20 MB limit (${formatFileSize(file.size)}).`,
    };
  }
  return { format: detected, error: null };
}

function FormatIcon({ format, className }: { format: UploadFormat; className?: string }) {
  switch (format) {
    case "notebook":
      return <FileCode2 className={className} />;
    case "iac":
      return <ServerCog className={className} />;
    case "epub":
      return <BookOpen className={className} />;
    default:
      return <FileText className={className} />;
  }
}

export function FileUploadZone({
  format = "pdf",
  onUploaded,
  onFormatDetected,
  compact = false,
  className,
}: {
  format?: UploadFormat;
  onUploaded: (source: Repository) => void;
  onFormatDetected?: (detected: UploadFormat) => void;
  compact?: boolean;
  className?: string;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [error, setError] = useState("");
  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);

  const spec = UPLOAD_FORMAT_SPECS[format];

  const startUpload = useCallback(
    async (file: File) => {
      setUploading(true);
      setError("");
      setUploadProgress(8);
      try {
        const source = await api.uploadFile(file, (pct) => {
          setUploadProgress(Math.max(8, pct));
        });
        onUploaded(source);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Could not upload file.");
        setUploading(false);
        setUploadProgress(0);
      }
    },
    [onUploaded]
  );

  const pickFile = useCallback(
    (file: File | null | undefined, autoUpload = false) => {
      if (!file || uploading) return;
      const { format: detected, error: validationError } = validateUploadFile(file);
      if (validationError || !detected) {
        setError(validationError ?? "Unsupported file format.");
        setSelectedFile(null);
        return;
      }

      if (detected !== format) {
        onFormatDetected?.(detected);
      }
      setError("");
      setSelectedFile(file);

      if (autoUpload) {
        void startUpload(file);
      }
    },
    [format, onFormatDetected, startUpload, uploading]
  );

  const handleDragOver = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.stopPropagation();
    if (!uploading) {
      setIsDragging(true);
    }
  };

  const handleDragLeave = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.stopPropagation();
    setIsDragging(false);
  };

  const handleDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.stopPropagation();
    setIsDragging(false);
    if (uploading) return;
    const file = event.dataTransfer.files?.[0];
    // Smart auto-detection on drop: switch active pill/sub-format & start uploading immediately
    pickFile(file, true);
  };

  const clearSelection = () => {
    if (uploading) return;
    setSelectedFile(null);
    setError("");
    setUploadProgress(0);
    if (inputRef.current) {
      inputRef.current.value = "";
    }
  };

  return (
    <div className={cn("space-y-3", className)}>
      <input
        ref={inputRef}
        type="file"
        accept={spec.accept}
        aria-label={`Upload ${spec.label}`}
        className="sr-only"
        onChange={(event) => {
          const file = event.target.files?.[0];
          pickFile(file, false);
        }}
      />

      {!selectedFile ? (
        <div
          role="button"
          tabIndex={0}
          onClick={() => !uploading && inputRef.current?.click()}
          onKeyDown={(event) => {
            if ((event.key === "Enter" || event.key === " ") && !uploading) {
              event.preventDefault();
              inputRef.current?.click();
            }
          }}
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
          aria-label={spec.dropPrompt}
          className={cn(
            "group relative flex cursor-pointer items-center justify-between gap-3 border border-dashed bg-background/85 backdrop-blur-sm transition-all duration-200 focus-visible:border-foreground focus-visible:outline-none",
            compact ? "px-3.5 py-4" : "min-h-12 px-4 py-3 sm:min-h-[50px]",
            isDragging
              ? "border-foreground bg-foreground/[0.06]"
              : "border-input hover:border-foreground/60"
          )}
        >
          <div className="flex min-w-0 items-center gap-3">
            <div className="flex shrink-0 items-center border-r border-border/70 pr-3 font-mono text-[11px] tracking-[0.12em] text-muted-foreground uppercase transition-colors group-hover:text-foreground">
              {spec.shortTag}
            </div>
            <div className="flex min-w-0 items-center gap-2.5">
              <Upload className="size-3.5 shrink-0 text-muted-foreground transition-transform duration-200 group-hover:-translate-y-0.5 group-hover:text-foreground" />
              <span className="truncate font-mono text-xs tracking-wide text-muted-foreground group-hover:text-foreground sm:text-sm">
                {isDragging ? "Release to auto-detect & index..." : spec.dropPrompt}
              </span>
            </div>
          </div>

          <span className="hidden shrink-0 border border-border/80 px-2 py-0.5 font-mono text-[10px] tracking-[0.12em] text-muted-foreground uppercase transition-colors group-hover:border-foreground group-hover:text-foreground sm:inline-block">
            Browse
          </span>
        </div>
      ) : (
        <div
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
          className="border border-foreground/75 bg-background/90 backdrop-blur-sm"
        >
          <div className="flex flex-col sm:flex-row sm:items-center">
            <div className="flex min-w-0 flex-1 items-center gap-3 px-3.5 py-2.5 sm:py-3">
              <div className="flex size-7 shrink-0 items-center justify-center border border-border bg-card text-foreground">
                <FormatIcon format={detectUploadFormat(selectedFile) ?? format} className="size-3.5" />
              </div>
              <div className="min-w-0 flex-1">
                <p className="truncate font-mono text-xs font-medium text-foreground sm:text-sm">
                  {selectedFile.name}
                </p>
                <p className="tabular-telemetry font-mono text-[10px] tracking-[0.1em] text-muted-foreground uppercase">
                  {uploading
                    ? uploadProgress < 100
                      ? `UPLOADING // ${uploadProgress}%`
                      : "DISPATCHING TO VECTOR PIPELINE..."
                    : `${formatFileSize(selectedFile.size)} · READY TO INDEX`}
                </p>
              </div>
              {!uploading && (
                <div className="flex shrink-0 items-center gap-1">
                  <button
                    type="button"
                    onClick={() => inputRef.current?.click()}
                    aria-label="Replace file"
                    title="Replace file"
                    className="inline-flex size-7 items-center justify-center rounded-[2px] border border-border/80 text-muted-foreground transition-colors hover:border-foreground hover:text-foreground"
                  >
                    <RefreshCw className="size-3" />
                  </button>
                  <button
                    type="button"
                    onClick={clearSelection}
                    aria-label="Clear selected file"
                    title="Clear"
                    className="inline-flex size-7 items-center justify-center rounded-[2px] border border-border/80 text-muted-foreground transition-colors hover:border-destructive hover:text-destructive"
                  >
                    <X className="size-3" />
                  </button>
                </div>
              )}
            </div>

            <Button
              type="button"
              variant="outline"
              size="lg"
              onClick={() => void startUpload(selectedFile)}
              disabled={uploading}
              className="h-11 rounded-none border-0 border-t border-input bg-foreground px-6 text-background transition-all duration-200 hover:bg-foreground/90 hover:text-background sm:h-auto sm:self-stretch sm:border-t-0 sm:border-l"
            >
              {uploading ? (
                <>
                  <Loader2 className="size-3.5 animate-spin" />
                  Indexing
                </>
              ) : (
                <>
                  {spec.ctaLabel}
                  <ArrowRight className="size-3.5" />
                </>
              )}
            </Button>
          </div>

          {uploading && (
            <div className="h-[2px] w-full bg-border/60">
              <div
                className="h-full bg-foreground transition-all duration-200 ease-out"
                style={{ width: `${uploadProgress}%` }}
              />
            </div>
          )}
        </div>
      )}

      {error ? (
        <p role="alert" className="font-mono text-xs tracking-wide text-destructive">
          ERR // {error}
        </p>
      ) : (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 pt-0.5 font-mono text-[10px] tracking-[0.12em] text-muted-foreground/80 uppercase">
          <span>{spec.acceptHint}</span>
          <span>·</span>
          <span>{spec.citationHint}</span>
        </div>
      )}
    </div>
  );
}
