export type IndexStatus = "PENDING" | "INDEXING" | "READY" | "FAILED";

export type SourceType = "GITHUB_REPO" | "PDF";

export type Repository = {
  id: string;
  githubRepoId: number;
  owner: string;
  name: string;
  fullName: string;
  isPrivate: boolean;
  defaultBranch: string;
  language: string | null;
  htmlUrl: string | null;
  description: string | null;
  indexStatus: IndexStatus;
  indexedAt: string | null;
  chunkCount: number;
  filesTotal: number;
  filesProcessed: number;
  errorMessage: string | null;
  sourceType?: SourceType;
  fileName?: string | null;
  fileSizeBytes?: number | null;
  pageCount?: number | null;
};

export function isPdfSource(
  source: Pick<Repository, "sourceType" | "fileName"> | null | undefined
): boolean {
  return source?.sourceType === "PDF";
}

export function formatFileSize(bytes: number | null | undefined): string {
  if (bytes == null || !Number.isFinite(bytes) || bytes <= 0) return "";
  if (bytes >= 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

export type IndexStatusResponse = {
  repositoryId: string;
  indexStatus: IndexStatus;
  filesTotal: number;
  filesProcessed: number;
  chunkCount: number;
  chunksTotal: number;
  chunksProcessed: number;
  indexingStage: "creating" | "fetching" | "chunking" | "embedding" | "saving" | "done" | null;
  indexingDetail: string | null;
  indexedAt: string | null;
  errorMessage: string | null;
};

export type ChatSession = {
  id: string;
  repositoryId: string;
  title: string;
  createdAt: string;
};

export type Citation = {
  filePath: string;
  startLine: number | null;
  endLine: number | null;
  language: string | null;
  sourceType?: SourceType | string | null;
  pageNumber?: number | null;
  sectionHeading?: string | null;
  chunkIndex?: number | null;
};

export type ChatMessage = {
  id: string;
  role: "USER" | "ASSISTANT";
  content: string;
  citations: Citation[];
  createdAt: string;
  responseModel?: { model: string; fallback: boolean; provider?: string };
};

export class ApiError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

const WORKSPACE_ID_KEY = "trace-workspace-id";

export function getWorkspaceId(): string {
  if (typeof window === "undefined") return "";
  let workspaceId = localStorage.getItem(WORKSPACE_ID_KEY);
  if (!workspaceId) {
    workspaceId = crypto.randomUUID();
    localStorage.setItem(WORKSPACE_ID_KEY, workspaceId);
  }
  return workspaceId;
}

export function getApiBaseUrl() {
  // Same-origin Next.js rewrite (/backend -> backendOrigin) eliminates cross-origin CORS OPTIONS preflights
  return "/backend";
}

export function getStreamBaseUrl() {
  // Direct backend origin for SSE streaming & large multipart uploads (avoids Vercel 4.5MB proxy payload cap)
  return (
    process.env.NEXT_PUBLIC_API_BASE_URL ||
    "https://trace-backend.onrender.com"
  ).replace(/\/$/, "");
}

async function parseError(res: Response): Promise<string> {
  try {
    const data = await res.json();
    return data.message ?? data.error ?? res.statusText;
  } catch {
    return res.statusText || "Request failed";
  }
}

export async function apiFetch<T>(
  path: string,
  init?: RequestInit,
): Promise<T> {
  const res = await fetch(`${getApiBaseUrl()}${path}`, {
    cache: "no-store",
    ...init,
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      "X-Workspace-Id": getWorkspaceId(),
      ...(init?.headers ?? {}),
    },
  });

  if (!res.ok) {
    throw new ApiError(res.status, await parseError(res));
  }

  if (res.status === 204) {
    return undefined as T;
  }

  return res.json() as Promise<T>;
}

function uploadPdfDirect(
  file: File,
  onProgress?: (percent: number) => void
): Promise<Repository> {
  return new Promise((resolve, reject) => {
    const formData = new FormData();
    formData.append("file", file);

    const xhr = new XMLHttpRequest();
    const url = `${getStreamBaseUrl()}/api/sources/pdf`;
    xhr.open("POST", url, true);
    xhr.withCredentials = true;
    xhr.setRequestHeader("X-Workspace-Id", getWorkspaceId());

    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable && onProgress) {
        const pct = Math.min(99, Math.round((event.loaded / event.total) * 100));
        onProgress(pct);
      }
    };

    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        try {
          onProgress?.(100);
          resolve(JSON.parse(xhr.responseText) as Repository);
        } catch {
          reject(new ApiError(xhr.status, "Invalid server response after PDF upload"));
        }
        return;
      }

      let message = xhr.statusText || "PDF upload failed";
      try {
        const parsed = JSON.parse(xhr.responseText);
        message = parsed.message ?? parsed.error ?? message;
      } catch {
        // Keep statusText fallback
      }
      reject(new ApiError(xhr.status, message));
    };

    xhr.onerror = () => {
      reject(new ApiError(0, "Network error while uploading PDF. Please retry."));
    };

    xhr.onabort = () => {
      reject(new ApiError(0, "PDF upload cancelled."));
    };

    xhr.send(formData);
  });
}

export const api = {
  analyzeRepo: (repoUrl: string) =>
    apiFetch<Repository>("/api/repos/analyze", {
      method: "POST",
      body: JSON.stringify({ repoUrl }),
    }),
  uploadPdf: (file: File, onProgress?: (percent: number) => void) =>
    uploadPdfDirect(file, onProgress),
  listRepos: (refresh = true) =>
    apiFetch<Repository[]>(`/api/repos?refresh=${refresh}`),
  getRepo: (id: string) => apiFetch<Repository>(`/api/repos/${id}`),
  startIndex: (id: string) =>
    apiFetch<Repository>(`/api/repos/${id}/index`, { method: "POST" }),
  indexStatus: (id: string) =>
    apiFetch<IndexStatusResponse>(`/api/repos/${id}/status`),
  indexStatusByUrl: (url: string) =>
    apiFetch<IndexStatusResponse>(`/api/repos/analyze/status?url=${encodeURIComponent(url)}`),
  createSession: (repositoryId: string, title?: string) =>
    apiFetch<ChatSession>("/api/chat/sessions", {
      method: "POST",
      body: JSON.stringify({ repositoryId, title }),
    }),
  listSessions: (repositoryId: string) =>
    apiFetch<ChatSession[]>(
      `/api/chat/sessions?repositoryId=${encodeURIComponent(repositoryId)}`
    ),
  getMessages: (sessionId: string) =>
    apiFetch<ChatMessage[]>(`/api/chat/sessions/${sessionId}`),
};
