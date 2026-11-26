package model

import (
	"time"

	"github.com/google/uuid"
)

// AnonymousWorkspaceID is the legacy fallback owner used when an HTTP REST call
// omits X-Workspace-Id (preserved for 1:1 compatibility with the frontend & existing rows).
var AnonymousWorkspaceID = uuid.MustParse("00000000-0000-0000-0000-000000000001")

type SourceType string

const (
	SourceGitHub   SourceType = "GITHUB_REPO"
	SourcePDF      SourceType = "PDF"
	SourceNotebook SourceType = "NOTEBOOK"
	SourceIAC      SourceType = "IAC"
	SourceEPUB     SourceType = "EPUB"
)

func (s SourceType) Effective() SourceType {
	if s == "" {
		return SourceGitHub
	}
	return s
}

type IndexStatus string

const (
	StatusPending  IndexStatus = "PENDING"
	StatusIndexing IndexStatus = "INDEXING"
	StatusReady    IndexStatus = "READY"
	StatusFailed   IndexStatus = "FAILED"
)

type MessageRole string

const (
	RoleUser      MessageRole = "USER"
	RoleAssistant MessageRole = "ASSISTANT"
)

// Repository mirrors the `repositories` Postgres table.
type Repository struct {
	ID                 uuid.UUID
	UserID             uuid.UUID
	SourceType         SourceType
	GithubRepoID       int64
	Owner              string
	Name               string
	FullName           string
	IsPrivate          bool
	DefaultBranch      string
	Language           *string
	HTMLURL            *string
	Description        *string
	IndexStatus        IndexStatus
	IndexedAt          *time.Time
	ChunkCount         int
	FilesTotal         int
	FilesProcessed     int
	ChunksTotal        int
	ChunksProcessed    int
	IndexingStage      *string
	IndexingDetail     *string
	ErrorMessage       *string
	TreeSHA            *string
	IndexedFilesJSON   *string
	FileName           *string
	FileSizeBytes      *int64
	PageCount          *int
	StorageKey         *string
	SourceMetadataJSON *string
	CreatedAt          time.Time
	UpdatedAt          time.Time
}

// RepositoryResponse matches trace.backend.dto.RepositoryResponse 1:1.
type RepositoryResponse struct {
	ID             uuid.UUID   `json:"id"`
	GithubRepoID   int64       `json:"githubRepoId"`
	Owner          string      `json:"owner"`
	Name           string      `json:"name"`
	FullName       string      `json:"fullName"`
	IsPrivate      bool        `json:"isPrivate"`
	DefaultBranch  string      `json:"defaultBranch"`
	Language       *string     `json:"language"`
	HTMLURL        *string     `json:"htmlUrl"`
	Description    *string     `json:"description"`
	IndexStatus    IndexStatus `json:"indexStatus"`
	IndexedAt      *time.Time  `json:"indexedAt"`
	ChunkCount     int         `json:"chunkCount"`
	FilesTotal     int         `json:"filesTotal"`
	FilesProcessed int         `json:"filesProcessed"`
	ErrorMessage   *string     `json:"errorMessage"`
	SourceType     SourceType  `json:"sourceType"`
	FileName       *string     `json:"fileName"`
	FileSizeBytes  *int64      `json:"fileSizeBytes"`
	PageCount      *int        `json:"pageCount"`
}

func (r Repository) ToResponse() RepositoryResponse {
	return RepositoryResponse{
		ID:             r.ID,
		GithubRepoID:   r.GithubRepoID,
		Owner:          r.Owner,
		Name:           r.Name,
		FullName:       r.FullName,
		IsPrivate:      r.IsPrivate,
		DefaultBranch:  r.DefaultBranch,
		Language:       r.Language,
		HTMLURL:        r.HTMLURL,
		Description:    r.Description,
		IndexStatus:    r.IndexStatus,
		IndexedAt:      r.IndexedAt,
		ChunkCount:     r.ChunkCount,
		FilesTotal:     r.FilesTotal,
		FilesProcessed: r.FilesProcessed,
		ErrorMessage:   r.ErrorMessage,
		SourceType:     r.SourceType.Effective(),
		FileName:       r.FileName,
		FileSizeBytes:  r.FileSizeBytes,
		PageCount:      r.PageCount,
	}
}

// IndexStatusResponse matches trace.backend.dto.IndexStatusResponse 1:1.
type IndexStatusResponse struct {
	RepositoryID    *uuid.UUID  `json:"repositoryId"`
	IndexStatus     IndexStatus `json:"indexStatus"`
	FilesTotal      int         `json:"filesTotal"`
	FilesProcessed  int         `json:"filesProcessed"`
	ChunkCount      int         `json:"chunkCount"`
	ChunksTotal     int         `json:"chunksTotal"`
	ChunksProcessed int         `json:"chunksProcessed"`
	IndexingStage   *string     `json:"indexingStage"`
	IndexingDetail  *string     `json:"indexingDetail"`
	IndexedAt       *time.Time  `json:"indexedAt"`
	ErrorMessage    *string     `json:"errorMessage"`
}

type AnalyzeRepoRequest struct {
	RepoURL string `json:"repoUrl"`
}

type CreateChatSessionRequest struct {
	RepositoryID uuid.UUID `json:"repositoryId"`
	Title        string    `json:"title"`
}

type ChatSessionResponse struct {
	ID           uuid.UUID `json:"id"`
	RepositoryID uuid.UUID `json:"repositoryId"`
	Title        string    `json:"title"`
	CreatedAt    time.Time `json:"createdAt"`
}

type Citation struct {
	FilePath       string  `json:"filePath"`
	StartLine      *int    `json:"startLine"`
	EndLine        *int    `json:"endLine"`
	Language       *string `json:"language"`
	SourceType     *string `json:"sourceType"`
	PageNumber     *int    `json:"pageNumber"`
	SectionHeading *string `json:"sectionHeading"`
	ChunkIndex     *int    `json:"chunkIndex"`
}

type ChatMessageRequest struct {
	SessionID           *uuid.UUID `json:"sessionId"`
	Content             string     `json:"content"`
	Temperature         *float64   `json:"temperature"`
	MaxTokens           *int       `json:"maxTokens"`
	TopK                *int       `json:"topK"`
	SimilarityThreshold *float64   `json:"similarityThreshold"`
	SystemPrompt        *string    `json:"systemPrompt"`
}

type ChatMessageResponse struct {
	ID        uuid.UUID   `json:"id"`
	Role      MessageRole `json:"role"`
	Content   string      `json:"content"`
	Citations []Citation  `json:"citations"`
	CreatedAt time.Time   `json:"createdAt"`
}

type McpAPIKey struct {
	ID          uuid.UUID
	WorkspaceID uuid.UUID
	KeyHash     string
	KeyPrefix   string
	KeyLast4    string
	Label       *string
	Revoked     bool
	CreatedAt   time.Time
	LastUsedAt  *time.Time
	RevokedAt   *time.Time
}

func (k McpAPIKey) MaskedPreview() string {
	return k.KeyPrefix + "••••••••••••" + k.KeyLast4
}

type McpKeyStatusResponse struct {
	HasActiveKey    bool       `json:"hasActiveKey"`
	ID              *uuid.UUID `json:"id"`
	MaskedKey       *string    `json:"maskedKey"`
	KeyPrefix       *string    `json:"keyPrefix"`
	KeyLast4        *string    `json:"keyLast4"`
	Label           *string    `json:"label"`
	CreatedAt       *time.Time `json:"createdAt"`
	LastUsedAt      *time.Time `json:"lastUsedAt"`
	McpEndpointPath string     `json:"mcpEndpointPath"`
}

func EmptyMcpKeyStatus() McpKeyStatusResponse {
	return McpKeyStatusResponse{
		HasActiveKey:    false,
		McpEndpointPath: "/api/mcp",
	}
}

type McpKeyGeneratedResponse struct {
	ID              uuid.UUID `json:"id"`
	APIKey          string    `json:"apiKey"`
	MaskedKey       string    `json:"maskedKey"`
	KeyPrefix       string    `json:"keyPrefix"`
	KeyLast4        string    `json:"keyLast4"`
	Label           *string   `json:"label"`
	CreatedAt       time.Time `json:"createdAt"`
	McpEndpointPath string    `json:"mcpEndpointPath"`
}

// VectorChunk is the domain representation of a single row in trace_vectors_cf_384.
type VectorChunk struct {
	ID        uuid.UUID
	Content   string
	Metadata  map[string]any
	Embedding []float32
}

// SearchHit represents a ranked PgVector similarity result.
type SearchHit struct {
	Content  string
	Score    float64
	SourceID string
	Metadata map[string]any
	Citation Citation
}
