"use client";

import { useCallback, useRef, useState, type DragEvent } from "react";
import { ArrowRight, FileText, Loader2, RefreshCw, Upload, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { api, formatFileSize, type Repository } from "@/lib/api";
import { cn } from "@/lib/utils";

export const MAX_PDF_UPLOAD_BYTES = 20 * 1024 * 1024; // 20 MB

export function validatePdfFile(file: File): string | null {
  const lowerName = file.name.toLowerCase();
  const isPdfType =
    file.type === "application/pdf" ||
    file.type === "application/x-pdf" ||
    lowerName.endsWith(".pdf");
  if (!isPdfType) {
    return "Only PDF (.pdf) documents are supported.";
  }
  if (file.size <= 0) {
    return "Selected PDF file is empty.";
  }
  if (file.size > MAX_PDF_UPLOAD_BYTES) {
    return `PDF exceeds 20 MB limit (${formatFileSize(file.size)}).`;
  }
  return null;
}

export function PdfUploadZone({
  onUploaded,
  compact = false,
  className,
}: {
  onUploaded: (source: Repository) => void;
  compact?: boolean;
  className?: string;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [error, setError] = useState("");
  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);

  const pickFile = useCallback((file: File | null | undefined) => {
    if (!file) return;
    const validationError = validatePdfFile(file);
    if (validationError) {
      setError(validationError);
      setSelectedFile(null);
      return;
    }
    setError("");
    setSelectedFile(file);
  }, []);

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
    pickFile(file);
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

  const handleUpload = async () => {
    if (!selectedFile || uploading) return;
    setUploading(true);
    setError("");
    setUploadProgress(8);

    try {
      const source = await api.uploadPdf(selectedFile, (pct) => {
        setUploadProgress(Math.max(8, pct));
      });
      onUploaded(source);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not upload PDF document.");
      setUploading(false);
      setUploadProgress(0);
    }
  };

  return (
    <div className={cn("space-y-3", className)}>
      <input
        ref={inputRef}
        type="file"
        accept=".pdf,application/pdf"
        aria-label="Upload PDF document"
        className="sr-only"
        onChange={(event) => {
          const file = event.target.files?.[0];
          pickFile(file);
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
          aria-label="Drop a PDF file here or click to browse"
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
              PDF
            </div>
            <div className="flex min-w-0 items-center gap-2.5">
              <Upload className="size-3.5 shrink-0 text-muted-foreground transition-transform duration-200 group-hover:-translate-y-0.5 group-hover:text-foreground" />
              <span className="truncate font-mono text-xs tracking-wide text-muted-foreground group-hover:text-foreground sm:text-sm">
                {isDragging
                  ? "Release to attach PDF..."
                  : "Drop a PDF here or click to browse"}
              </span>
            </div>
          </div>

          <span className="hidden shrink-0 border border-border/80 px-2 py-0.5 font-mono text-[10px] tracking-[0.12em] text-muted-foreground uppercase transition-colors group-hover:border-foreground group-hover:text-foreground sm:inline-block">
            Browse
          </span>
        </div>
      ) : (
        <div className="border border-foreground/75 bg-background/90 backdrop-blur-sm">
          <div className="flex flex-col sm:flex-row sm:items-center">
            <div className="flex min-w-0 flex-1 items-center gap-3 px-3.5 py-2.5 sm:py-3">
              <div className="flex size-7 shrink-0 items-center justify-center border border-border bg-card text-foreground">
                <FileText className="size-3.5" />
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
                    aria-label="Replace PDF"
                    title="Replace PDF"
                    className="inline-flex size-7 items-center justify-center rounded-[2px] border border-border/80 text-muted-foreground transition-colors hover:border-foreground hover:text-foreground"
                  >
                    <RefreshCw className="size-3" />
                  </button>
                  <button
                    type="button"
                    onClick={clearSelection}
                    aria-label="Clear selected PDF"
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
              onClick={() => void handleUpload()}
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
                  Index PDF
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
          <span>.PDF ONLY</span>
          <span>·</span>
          <span>MAX 20 MB</span>
          <span>·</span>
          <span>PAGE-PRESERVING CITATIONS</span>
        </div>
      )}
    </div>
  );
}
