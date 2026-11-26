package mcp

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"strconv"
	"strings"

	"github.com/google/uuid"

	"trace/backend-go/internal/embedding"
	"trace/backend-go/internal/model"
	"trace/backend-go/internal/store"
)

const (
	ProtocolVersion = "2025-03-26"
	ServerName      = "trace-mcp"
	ServerVersion   = "1.0.0"
)

// SourceBackend abstracts repo + vector reads so the MCP server can be unit-tested cleanly.
type SourceBackend interface {
	ListByUser(ctx context.Context, userID uuid.UUID) ([]model.RepositoryResponse, error)
	FindByIDAndUser(ctx context.Context, id, userID uuid.UUID) (model.Repository, error)
	SearchVectors(ctx context.Context, userID uuid.UUID, optionalSourceID *uuid.UUID, query string, topK int, threshold float64) ([]model.SearchHit, error)
	FetchSourceChunks(ctx context.Context, userID, sourceID uuid.UUID, filePath string, unitNumber *int, offset, limit int) ([]model.SearchHit, error)
}

// PostgresSourceBackend connects MCP tools to RepoStore, VectorStore, and CloudflareEmbedder.
type PostgresSourceBackend struct {
	Repos    *store.RepoStore
	Vectors  *store.VectorStore
	Embedder embedding.Embedder
}

func (b *PostgresSourceBackend) ListByUser(ctx context.Context, userID uuid.UUID) ([]model.RepositoryResponse, error) {
	return b.Repos.ListByUser(ctx, userID)
}

func (b *PostgresSourceBackend) FindByIDAndUser(ctx context.Context, id, userID uuid.UUID) (model.Repository, error) {
	return b.Repos.FindByIDAndUser(ctx, id, userID)
}

func (b *PostgresSourceBackend) SearchVectors(ctx context.Context, userID uuid.UUID, optionalSourceID *uuid.UUID, query string, topK int, threshold float64) ([]model.SearchHit, error) {
	vec, err := b.Embedder.EmbedQuery(ctx, query)
	if err != nil {
		return nil, err
	}
	return b.Vectors.Search(ctx, userID, optionalSourceID, vec, topK, threshold)
}

func (b *PostgresSourceBackend) FetchSourceChunks(ctx context.Context, userID, sourceID uuid.UUID, filePath string, unitNumber *int, offset, limit int) ([]model.SearchHit, error) {
	return b.Vectors.FetchSourceChunks(ctx, userID, sourceID, filePath, unitNumber, offset, limit)
}

// Server implements TRACE's tenant-isolated JSON-RPC 2.0 MCP server.
type Server struct {
	backend SourceBackend
}

func NewServer(backend SourceBackend) *Server {
	return &Server{backend: backend}
}

// HandleJSONRPC processes a single MCP JSON-RPC 2.0 request strictly inside workspaceID.
// Returns (nil, true) for JSON-RPC notifications (HTTP 202 Accepted).
func (s *Server) HandleJSONRPC(ctx context.Context, workspaceID uuid.UUID, req map[string]any) (map[string]any, bool) {
	if req == nil || fmt.Sprint(req["jsonrpc"]) != "2.0" {
		var id any
		if req != nil {
			id = req["id"]
		}
		return rpcError(id, -32600, "Invalid Request: jsonrpc must be '2.0'"), false
	}

	id, hasID := req["id"]
	method, _ := req["method"].(string)
	if strings.TrimSpace(method) == "" {
		return rpcError(id, -32600, "Invalid Request: missing method"), false
	}

	if !hasID || id == nil || strings.HasPrefix(method, "notifications/") {
		return nil, true
	}

	params, _ := req["params"].(map[string]any)
	if params == nil {
		params = map[string]any{}
	}

	switch method {
	case "initialize":
		return rpcOK(id, buildInitializeResult(params)), false
	case "ping":
		return rpcOK(id, map[string]any{}), false
	case "tools/list":
		return rpcOK(id, map[string]any{"tools": ToolDefinitions()}), false
	case "tools/call":
		return s.handleToolCall(ctx, id, workspaceID, params), false
	default:
		return rpcError(id, -32601, "Method not found: "+method), false
	}
}

func buildInitializeResult(params map[string]any) map[string]any {
	reqVer, _ := params["protocolVersion"].(string)
	negotiated := ProtocolVersion
	if reqVer == "2024-11-05" || reqVer == "2025-03-26" {
		negotiated = reqVer
	}
	return map[string]any{
		"protocolVersion": negotiated,
		"capabilities":    map[string]any{"tools": map[string]any{"listChanged": false}},
		"serverInfo":      map[string]any{"name": ServerName, "version": ServerVersion},
		"instructions": "TRACE MCP Server exposes your workspace's indexed GitHub repositories, PDFs, Jupyter notebooks, " +
			"IaC/CI configs, and EPUB books via 384-dim PgVector retrieval. Call list_sources first " +
			"to inspect available sourceIds, then search_knowledge or get_source_excerpts.",
	}
}

func ToolDefinitions() []map[string]any {
	return []map[string]any{
		{
			"name":        "list_sources",
			"description": "List all indexed knowledge sources (GitHub repositories, PDFs, Jupyter notebooks, IaC/CI configs, and EPUB books) in your authenticated TRACE workspace.",
			"inputSchema": map[string]any{
				"type": "object",
				"properties": map[string]any{
					"sourceType": map[string]any{
						"type":        "string",
						"enum":        []string{"GITHUB_REPO", "PDF", "NOTEBOOK", "IAC", "EPUB"},
						"description": "Optional filter by source type.",
					},
					"status": map[string]any{
						"type":        "string",
						"enum":        []string{"READY", "INDEXING", "PENDING", "FAILED"},
						"description": "Optional filter by indexing status.",
					},
				},
			},
		},
		{
			"name":        "search_knowledge",
			"description": "Run 384-dim semantic vector search across a specific indexed source or across all ready sources in your workspace. Returns ranked passages with exact citations (file:line, Page N, Chapter N, Cell N, or IaC Block).",
			"inputSchema": map[string]any{
				"type":     "object",
				"required": []string{"query"},
				"properties": map[string]any{
					"query": map[string]any{
						"type":        "string",
						"description": "Natural language question, symbol name, error message, or topic to search.",
					},
					"sourceId": map[string]any{
						"type":        "string",
						"description": "Optional UUID of a specific source from list_sources. Omit to search across all indexed sources in your workspace.",
					},
					"topK": map[string]any{
						"type":        "integer",
						"minimum":     1,
						"maximum":     15,
						"default":     5,
						"description": "Maximum number of ranked chunks to return (1-15, default 5).",
					},
					"similarityThreshold": map[string]any{
						"type":        "number",
						"minimum":     0.0,
						"maximum":     1.0,
						"default":     0.30,
						"description": "Minimum cosine similarity score (0.0-1.0, default 0.30).",
					},
				},
			},
		},
		{
			"name":        "get_source_details",
			"description": "Retrieve metadata, indexing status, vector count, unit count (files/pages/chapters/cells/blocks), and file info for a specific source owned by your workspace.",
			"inputSchema": map[string]any{
				"type":     "object",
				"required": []string{"sourceId"},
				"properties": map[string]any{
					"sourceId": map[string]any{
						"type":        "string",
						"description": "UUID of the indexed source.",
					},
				},
			},
		},
		{
			"name":        "get_source_excerpts",
			"description": "Read ordered indexed chunks directly from a specific source, optionally filtered by filePath (for GitHub repos) or unitNumber (1-based page, chapter, cell, or start line).",
			"inputSchema": map[string]any{
				"type":     "object",
				"required": []string{"sourceId"},
				"properties": map[string]any{
					"sourceId": map[string]any{
						"type":        "string",
						"description": "UUID of the indexed source.",
					},
					"filePath": map[string]any{
						"type":        "string",
						"description": "Optional exact file path within a GitHub repository (e.g., src/App.tsx).",
					},
					"unitNumber": map[string]any{
						"type":        "integer",
						"minimum":     1,
						"description": "Optional 1-based page (PDF), chapter (EPUB), cell (Notebook), or starting line (IaC).",
					},
					"offset": map[string]any{
						"type":        "integer",
						"minimum":     0,
						"default":     0,
						"description": "Chunk pagination offset (default 0).",
					},
					"limit": map[string]any{
						"type":        "integer",
						"minimum":     1,
						"maximum":     20,
						"default":     6,
						"description": "Maximum chunks to return (1-20, default 6).",
					},
				},
			},
		},
	}
}

func (s *Server) handleToolCall(ctx context.Context, id any, workspaceID uuid.UUID, params map[string]any) map[string]any {
	name := strings.TrimSpace(stringArg(params["name"]))
	args, _ := params["arguments"].(map[string]any)
	if args == nil {
		args = map[string]any{}
	}

	var result map[string]any
	var err error
	switch name {
	case "list_sources":
		result, err = s.execListSources(ctx, workspaceID, args)
	case "search_knowledge":
		result, err = s.execSearchKnowledge(ctx, workspaceID, args)
	case "get_source_details":
		result, err = s.execGetSourceDetails(ctx, workspaceID, args)
	case "get_source_excerpts":
		result, err = s.execGetSourceExcerpts(ctx, workspaceID, args)
	default:
		return rpcError(id, -32602, "Unknown tool: "+name)
	}

	if err != nil {
		if errors.Is(err, store.ErrNotFound) {
			return rpcOK(id, toolErr("Source not found in your workspace."))
		}
		return rpcOK(id, toolErr(err.Error()))
	}
	return rpcOK(id, result)
}

func (s *Server) execListSources(ctx context.Context, workspaceID uuid.UUID, args map[string]any) (map[string]any, error) {
	typeFilter := strings.ToUpper(strings.TrimSpace(stringArg(args["sourceType"])))
	statusFilter := strings.ToUpper(strings.TrimSpace(stringArg(args["status"])))

	all, err := s.backend.ListByUser(ctx, workspaceID)
	if err != nil {
		return nil, err
	}

	items := make([]map[string]any, 0, len(all))
	var summary strings.Builder
	for _, r := range all {
		st := string(r.SourceType.Effective())
		if typeFilter != "" && st != typeFilter {
			continue
		}
		if statusFilter != "" && string(r.IndexStatus) != statusFilter {
			continue
		}
		items = append(items, summarizeSource(r))
	}

	if len(items) == 0 {
		summary.WriteString("No indexed sources found in this workspace.")
	} else {
		fmt.Fprintf(&summary, "Found %d source(s):\n", len(items))
		for _, item := range items {
			fmt.Fprintf(&summary, "- %s [id=%s, type=%s, status=%s, chunks=%v]\n",
				item["name"], item["id"], item["sourceType"], item["status"], item["chunkCount"])
		}
	}
	return toolOK(strings.TrimSpace(summary.String()), map[string]any{
		"count":   len(items),
		"sources": items,
	}), nil
}

func (s *Server) execSearchKnowledge(ctx context.Context, workspaceID uuid.UUID, args map[string]any) (map[string]any, error) {
	query := strings.TrimSpace(stringArg(args["query"]))
	if query == "" {
		return nil, errors.New("Missing required parameter: query")
	}

	var sourceID *uuid.UUID
	if rawID := strings.TrimSpace(stringArg(args["sourceId"])); rawID != "" {
		parsed, err := uuid.Parse(rawID)
		if err != nil {
			return nil, errors.New("Invalid UUID for parameter 'sourceId'")
		}
		if _, err := s.backend.FindByIDAndUser(ctx, parsed, workspaceID); err != nil {
			return nil, err
		}
		sourceID = &parsed
	}

	topK := intArg(args["topK"], 5, 1, 15)
	thresh := floatArg(args["similarityThreshold"], 0.30, 0.0, 1.0)

	hits, err := s.backend.SearchVectors(ctx, workspaceID, sourceID, query, topK, thresh)
	if err != nil {
		return nil, err
	}

	results := make([]map[string]any, 0, len(hits))
	var text strings.Builder
	if len(hits) == 0 {
		fmt.Fprintf(&text, "No matching passages found above similarity threshold %.2f.", thresh)
	} else {
		fmt.Fprintf(&text, "Retrieved %d matching passage(s):\n\n", len(hits))
		for i, h := range hits {
			label := FormatCitationLabel(h.Citation)
			results = append(results, map[string]any{
				"rank":     i + 1,
				"sourceId": h.SourceID,
				"score":    math.Round(h.Score*1000) / 1000,
				"citation": label,
				"metadata": citationToMap(h.Citation),
				"content":  h.Content,
			})
			fmt.Fprintf(&text, "[%d] %s (score: %.3f)\n%s\n\n---\n\n", i+1, label, h.Score, h.Content)
		}
	}

	var srcIDStr any
	if sourceID != nil {
		srcIDStr = sourceID.String()
	}
	return toolOK(strings.TrimSpace(text.String()), map[string]any{
		"query":    query,
		"sourceId": srcIDStr,
		"count":    len(results),
		"results":  results,
	}), nil
}

func (s *Server) execGetSourceDetails(ctx context.Context, workspaceID uuid.UUID, args map[string]any) (map[string]any, error) {
	sourceID, err := parseRequiredUUID(args["sourceId"], "sourceId")
	if err != nil {
		return nil, err
	}
	repo, err := s.backend.FindByIDAndUser(ctx, sourceID, workspaceID)
	if err != nil {
		return nil, err
	}
	resp := repo.ToResponse()
	details := summarizeSource(resp)
	details["description"] = resp.Description
	details["defaultBranch"] = resp.DefaultBranch
	details["language"] = resp.Language
	details["htmlUrl"] = resp.HTMLURL
	details["fileName"] = resp.FileName
	details["fileSizeBytes"] = resp.FileSizeBytes
	details["unitCount"] = details["unitsTotal"]
	if resp.IndexedAt != nil {
		details["indexedAt"] = resp.IndexedAt.Format("2006-01-02T15:04:05Z07:00")
	} else {
		details["indexedAt"] = nil
	}
	details["errorMessage"] = resp.ErrorMessage

	pretty, _ := json.MarshalIndent(details, "", "  ")
	return toolOK(string(pretty), details), nil
}

func (s *Server) execGetSourceExcerpts(ctx context.Context, workspaceID uuid.UUID, args map[string]any) (map[string]any, error) {
	sourceID, err := parseRequiredUUID(args["sourceId"], "sourceId")
	if err != nil {
		return nil, err
	}
	repo, err := s.backend.FindByIDAndUser(ctx, sourceID, workspaceID)
	if err != nil {
		return nil, err
	}
	filePath := strings.TrimSpace(stringArg(args["filePath"]))
	var unitPtr *int
	if args["unitNumber"] != nil {
		u := intArg(args["unitNumber"], 1, 1, 100_000)
		unitPtr = &u
	}
	offset := intArg(args["offset"], 0, 0, 100_000)
	limit := intArg(args["limit"], 6, 1, 20)

	hits, err := s.backend.FetchSourceChunks(ctx, workspaceID, sourceID, filePath, unitPtr, offset, limit)
	if err != nil {
		return nil, err
	}

	excerpts := make([]map[string]any, 0, len(hits))
	var text strings.Builder
	if len(hits) == 0 {
		fmt.Fprintf(&text, "No indexed excerpts matched the specified filters for %s.", repo.FullName)
	} else {
		fmt.Fprintf(&text, "Excerpts from %s (%d chunk(s)):\n\n", repo.FullName, len(hits))
		for _, h := range hits {
			label := FormatCitationLabel(h.Citation)
			excerpts = append(excerpts, map[string]any{
				"citation": label,
				"metadata": citationToMap(h.Citation),
				"content":  h.Content,
			})
			fmt.Fprintf(&text, "### %s\n%s\n\n", label, h.Content)
		}
	}

	return toolOK(strings.TrimSpace(text.String()), map[string]any{
		"sourceId":   sourceID.String(),
		"sourceName": repo.FullName,
		"offset":     offset,
		"count":      len(excerpts),
		"excerpts":   excerpts,
	}), nil
}

func summarizeSource(r model.RepositoryResponse) map[string]any {
	units := r.FilesTotal
	if r.PageCount != nil {
		units = *r.PageCount
	}
	return map[string]any{
		"id":         r.ID.String(),
		"name":       r.FullName,
		"sourceType": string(r.SourceType.Effective()),
		"status":     string(r.IndexStatus),
		"chunkCount": r.ChunkCount,
		"unitsTotal": units,
	}
}

func FormatCitationLabel(c model.Citation) string {
	st := "GITHUB_REPO"
	if c.SourceType != nil && *c.SourceType != "" {
		st = strings.ToUpper(*c.SourceType)
	}
	file := c.FilePath
	if file == "" {
		file = "source"
	}
	unit := c.PageNumber
	if unit == nil {
		unit = c.StartLine
	}
	heading := ""
	if c.SectionHeading != nil {
		heading = *c.SectionHeading
	}

	switch st {
	case "PDF":
		out := file
		if unit != nil {
			out += fmt.Sprintf(" · Page %d", *unit)
		}
		if heading != "" {
			out += " · " + heading
		}
		return out
	case "EPUB":
		out := file
		if unit != nil {
			out += fmt.Sprintf(" · Chapter %d", *unit)
		}
		if heading != "" {
			out += " · " + heading
		}
		return out
	case "NOTEBOOK":
		out := file
		if unit != nil {
			out += fmt.Sprintf(" · Cell %d", *unit)
		}
		if heading != "" {
			out += " · " + heading
		}
		return out
	case "IAC":
		out := file
		if heading != "" {
			out = "Block: " + heading
		}
		if unit != nil {
			out += fmt.Sprintf(" (Line %d)", *unit)
		}
		return out
	default:
		if c.StartLine != nil {
			if c.EndLine != nil && *c.EndLine != *c.StartLine {
				return fmt.Sprintf("%s:%d-%d", file, *c.StartLine, *c.EndLine)
			}
			return fmt.Sprintf("%s:%d", file, *c.StartLine)
		}
		return file
	}
}

func citationToMap(c model.Citation) map[string]any {
	m := map[string]any{
		"filePath":   c.FilePath,
		"sourceType": c.SourceType,
	}
	if c.StartLine != nil {
		m["startLine"] = *c.StartLine
	}
	if c.EndLine != nil {
		m["endLine"] = *c.EndLine
	}
	if c.PageNumber != nil {
		m["pageNumber"] = *c.PageNumber
	}
	if c.SectionHeading != nil {
		m["sectionHeading"] = *c.SectionHeading
	}
	if c.ChunkIndex != nil {
		m["chunkIndex"] = *c.ChunkIndex
	}
	return m
}

func toolOK(text string, structured map[string]any) map[string]any {
	return map[string]any{
		"content":           []map[string]any{{"type": "text", "text": text}},
		"structuredContent": structured,
		"isError":           false,
	}
}

func toolErr(msg string) map[string]any {
	return map[string]any{
		"content": []map[string]any{{"type": "text", "text": msg}},
		"isError": true,
	}
}

func rpcOK(id any, result any) map[string]any {
	return map[string]any{"jsonrpc": "2.0", "id": id, "result": result}
}

func rpcError(id any, code int, msg string) map[string]any {
	return map[string]any{"jsonrpc": "2.0", "id": id, "error": map[string]any{"code": code, "message": msg}}
}

func stringArg(v any) string {
	if s, ok := v.(string); ok {
		return s
	}
	return ""
}

func parseRequiredUUID(v any, field string) (uuid.UUID, error) {
	raw := strings.TrimSpace(stringArg(v))
	if raw == "" {
		return uuid.Nil, fmt.Errorf("Missing required UUID parameter: %s", field)
	}
	parsed, err := uuid.Parse(raw)
	if err != nil {
		return uuid.Nil, fmt.Errorf("Invalid UUID for parameter '%s'", field)
	}
	return parsed, nil
}

func intArg(v any, fallback, minV, maxV int) int {
	if v == nil {
		return fallback
	}
	var val int
	switch n := v.(type) {
	case float64:
		val = int(n)
	case int:
		val = n
	case string:
		p, err := strconv.Atoi(strings.TrimSpace(n))
		if err != nil {
			return fallback
		}
		val = p
	default:
		return fallback
	}
	if val < minV {
		return minV
	}
	if val > maxV {
		return maxV
	}
	return val
}

func floatArg(v any, fallback, minV, maxV float64) float64 {
	if v == nil {
		return fallback
	}
	var val float64
	switch n := v.(type) {
	case float64:
		val = n
	case int:
		val = float64(n)
	case string:
		p, err := strconv.ParseFloat(strings.TrimSpace(n), 64)
		if err != nil {
			return fallback
		}
		val = p
	default:
		return fallback
	}
	if math.IsNaN(val) || math.IsInf(val, 0) {
		return fallback
	}
	return math.Max(minV, math.Min(maxV, val))
}
