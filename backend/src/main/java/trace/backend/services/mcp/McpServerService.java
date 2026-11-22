package trace.backend.services.mcp;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.UUID;

import org.springframework.stereotype.Service;

import com.fasterxml.jackson.databind.ObjectMapper;

import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import trace.backend.dto.CitationDto;
import trace.backend.dto.RepositoryResponse;
import trace.backend.entity.IndexStatus;
import trace.backend.entity.SourceType;
import trace.backend.exceptions.NotFoundException;
import trace.backend.services.RepoService;
import trace.backend.services.ai.CodeContextRetriever;

/**
 * Standards-compliant Model Context Protocol (MCP) JSON-RPC 2.0 server implementation.
 * Every tool call runs strictly inside the authenticated {@code workspaceId} resolved from the
 * hashed MCP API key — zero cross-tenant access is possible.
 */
@Service
@RequiredArgsConstructor
@Slf4j
public class McpServerService {

    public static final String PROTOCOL_VERSION = "2025-03-26";
    public static final String SERVER_NAME = "trace-mcp";
    public static final String SERVER_VERSION = "1.0.0";
    private static final ObjectMapper OBJECT_MAPPER = new ObjectMapper();

    private final RepoService repoService;
    private final CodeContextRetriever codeContextRetriever;

    /**
     * Processes a single JSON-RPC 2.0 MCP message scoped strictly to {@code workspaceId}.
     * Returns {@code null} for JSON-RPC notifications (no {@code id}) so the controller replies {@code 202 Accepted}.
     */
    @SuppressWarnings("unchecked")
    public Map<String, Object> handleJsonRpc(UUID workspaceId, Map<String, Object> request) {
        if (request == null || !"2.0".equals(String.valueOf(request.get("jsonrpc")))) {
            return errorResponse(request != null ? request.get("id") : null, -32600, "Invalid Request: jsonrpc must be '2.0'");
        }

        Object id = request.get("id");
        Object methodObj = request.get("method");
        if (!(methodObj instanceof String method) || method.isBlank()) {
            return errorResponse(id, -32600, "Invalid Request: missing method");
        }

        // Notifications have no id and expect no JSON-RPC result payload
        if (id == null || method.startsWith("notifications/")) {
            return null;
        }

        Map<String, Object> params = request.get("params") instanceof Map<?, ?> p
                ? (Map<String, Object>) p
                : Map.of();

        return switch (method) {
            case "initialize" -> okResponse(id, buildInitializeResult(params));
            case "ping" -> okResponse(id, Map.of());
            case "tools/list" -> okResponse(id, Map.of("tools", buildToolDefinitions()));
            case "tools/call" -> handleToolCall(id, workspaceId, params);
            default -> errorResponse(id, -32601, "Method not found: " + method);
        };
    }

    private Map<String, Object> buildInitializeResult(Map<String, Object> params) {
        String requestedVersion = params.get("protocolVersion") instanceof String s && !s.isBlank()
                ? s : PROTOCOL_VERSION;
        String negotiatedVersion = ("2024-11-05".equals(requestedVersion) || "2025-03-26".equals(requestedVersion))
                ? requestedVersion
                : PROTOCOL_VERSION;

        Map<String, Object> result = new LinkedHashMap<>();
        result.put("protocolVersion", negotiatedVersion);
        result.put("capabilities", Map.of("tools", Map.of("listChanged", false)));
        result.put("serverInfo", Map.of("name", SERVER_NAME, "version", SERVER_VERSION));
        result.put("instructions",
                "TRACE MCP Server exposes your workspace's indexed GitHub repositories, PDFs, Jupyter notebooks, "
                        + "IaC/CI configs, and EPUB books via 384-dim PgVector retrieval. Call list_sources first "
                        + "to inspect available sourceIds, then search_knowledge or get_source_excerpts.");
        return result;
    }

    public List<Map<String, Object>> buildToolDefinitions() {
        return List.of(
                toolDef(
                        "list_sources",
                        "List all indexed knowledge sources (GitHub repositories, PDFs, Jupyter notebooks, IaC/CI configs, and EPUB books) in your authenticated TRACE workspace.",
                        schema(
                                Map.of(
                                        "sourceType", Map.of(
                                                "type", "string",
                                                "enum", List.of("GITHUB_REPO", "PDF", "NOTEBOOK", "IAC", "EPUB"),
                                                "description", "Optional filter by source type."
                                        ),
                                        "status", Map.of(
                                                "type", "string",
                                                "enum", List.of("READY", "INDEXING", "PENDING", "FAILED"),
                                                "description", "Optional filter by indexing status."
                                        )
                                ),
                                List.of()
                        )
                ),
                toolDef(
                        "search_knowledge",
                        "Run 384-dim semantic vector search across a specific indexed source or across all ready sources in your workspace. Returns ranked passages with exact citations (file:line, Page N, Chapter N, Cell N, or IaC Block).",
                        schema(
                                Map.of(
                                        "query", Map.of(
                                                "type", "string",
                                                "description", "Natural language question, symbol name, error message, or topic to search."
                                        ),
                                        "sourceId", Map.of(
                                                "type", "string",
                                                "description", "Optional UUID of a specific source from list_sources. Omit to search across all indexed sources in your workspace."
                                        ),
                                        "topK", Map.of(
                                                "type", "integer",
                                                "minimum", 1,
                                                "maximum", 15,
                                                "default", 5,
                                                "description", "Maximum number of ranked chunks to return (1-15, default 5)."
                                        ),
                                        "similarityThreshold", Map.of(
                                                "type", "number",
                                                "minimum", 0.0,
                                                "maximum", 1.0,
                                                "default", 0.30,
                                                "description", "Minimum cosine similarity score (0.0-1.0, default 0.30)."
                                        )
                                ),
                                List.of("query")
                        )
                ),
                toolDef(
                        "get_source_details",
                        "Retrieve metadata, indexing status, vector count, unit count (files/pages/chapters/cells/blocks), and file info for a specific source owned by your workspace.",
                        schema(
                                Map.of(
                                        "sourceId", Map.of(
                                                "type", "string",
                                                "description", "UUID of the indexed source."
                                        )
                                ),
                                List.of("sourceId")
                        )
                ),
                toolDef(
                        "get_source_excerpts",
                        "Read ordered indexed chunks directly from a specific source, optionally filtered by filePath (for GitHub repos) or unitNumber (1-based page, chapter, cell, or start line).",
                        schema(
                                Map.of(
                                        "sourceId", Map.of(
                                                "type", "string",
                                                "description", "UUID of the indexed source."
                                        ),
                                        "filePath", Map.of(
                                                "type", "string",
                                                "description", "Optional exact file path within a GitHub repository (e.g., src/App.tsx)."
                                        ),
                                        "unitNumber", Map.of(
                                                "type", "integer",
                                                "minimum", 1,
                                                "description", "Optional 1-based page (PDF), chapter (EPUB), cell (Notebook), or starting line (IaC)."
                                        ),
                                        "offset", Map.of(
                                                "type", "integer",
                                                "minimum", 0,
                                                "default", 0,
                                                "description", "Chunk pagination offset (default 0)."
                                        ),
                                        "limit", Map.of(
                                                "type", "integer",
                                                "minimum", 1,
                                                "maximum", 20,
                                                "default", 6,
                                                "description", "Maximum chunks to return (1-20, default 6)."
                                        )
                                ),
                                List.of("sourceId")
                        )
                )
        );
    }

    @SuppressWarnings("unchecked")
    private Map<String, Object> handleToolCall(Object id, UUID workspaceId, Map<String, Object> params) {
        String toolName = params.get("name") instanceof String s ? s.trim() : "";
        Map<String, Object> args = params.get("arguments") instanceof Map<?, ?> m
                ? (Map<String, Object>) m
                : Map.of();

        try {
            Map<String, Object> toolResult = switch (toolName) {
                case "list_sources" -> executeListSources(workspaceId, args);
                case "search_knowledge" -> executeSearchKnowledge(workspaceId, args);
                case "get_source_details" -> executeGetSourceDetails(workspaceId, args);
                case "get_source_excerpts" -> executeGetSourceExcerpts(workspaceId, args);
                default -> {
                    yield null;
                }
            };
            if (toolResult == null) {
                return errorResponse(id, -32602, "Unknown tool: " + toolName);
            }
            return okResponse(id, toolResult);
        } catch (NotFoundException e) {
            return okResponse(id, toolErrorResult("Source not found in your workspace."));
        } catch (IllegalArgumentException e) {
            return okResponse(id, toolErrorResult(e.getMessage()));
        } catch (Exception e) {
            log.error("[MCP] tool={} workspaceId={} failed: {}", toolName, workspaceId, e.getMessage(), e);
            return okResponse(id, toolErrorResult("Tool execution failed: " + e.getMessage()));
        }
    }

    private Map<String, Object> executeListSources(UUID workspaceId, Map<String, Object> args) {
        SourceType typeFilter = parseOptionalEnum(args.get("sourceType"), SourceType.class);
        IndexStatus statusFilter = parseOptionalEnum(args.get("status"), IndexStatus.class);

        List<RepositoryResponse> sources = repoService.listStored(workspaceId).stream()
                .filter(r -> typeFilter == null || (r.sourceType() != null ? r.sourceType() : SourceType.GITHUB_REPO) == typeFilter)
                .filter(r -> statusFilter == null || r.indexStatus() == statusFilter)
                .toList();

        List<Map<String, Object>> items = new ArrayList<>(sources.size());
        for (RepositoryResponse r : sources) {
            items.add(summarizeSource(r));
        }

        Map<String, Object> structured = new LinkedHashMap<>();
        structured.put("count", items.size());
        structured.put("sources", items);

        StringBuilder summary = new StringBuilder();
        if (items.isEmpty()) {
            summary.append("No indexed sources found in this workspace.");
        } else {
            summary.append("Found ").append(items.size()).append(" source(s):\n");
            for (RepositoryResponse r : sources) {
                summary.append("- ").append(r.fullName())
                        .append(" [id=").append(r.id())
                        .append(", type=").append(r.sourceType() != null ? r.sourceType() : SourceType.GITHUB_REPO)
                        .append(", status=").append(r.indexStatus())
                        .append(", chunks=").append(r.chunkCount())
                        .append("]\n");
            }
        }
        return toolSuccessResult(summary.toString().trim(), structured);
    }

    private Map<String, Object> executeSearchKnowledge(UUID workspaceId, Map<String, Object> args) {
        String query = stringArg(args.get("query"));
        if (query == null || query.isBlank()) {
            throw new IllegalArgumentException("Missing required parameter: query");
        }
        UUID sourceId = parseOptionalUuid(args.get("sourceId"), "sourceId");
        if (sourceId != null) {
            // Strictly verify ownership before querying vectors
            repoService.getResponse(sourceId, workspaceId);
        }

        int topK = intArg(args.get("topK"), 5, 1, 15);
        double threshold = doubleArg(args.get("similarityThreshold"), 0.30, 0.0, 1.0);

        List<CodeContextRetriever.SearchHit> hits = codeContextRetriever.searchForWorkspace(
                workspaceId, sourceId, query, topK, threshold);

        List<Map<String, Object>> results = new ArrayList<>(hits.size());
        StringBuilder text = new StringBuilder();
        if (hits.isEmpty()) {
            text.append("No matching passages found above similarity threshold ").append(threshold).append(".");
        } else {
            text.append("Retrieved ").append(hits.size()).append(" matching passage(s):\n\n");
            for (int i = 0; i < hits.size(); i++) {
                CodeContextRetriever.SearchHit hit = hits.get(i);
                String citationLabel = formatCitationLabel(hit.citation());
                Map<String, Object> entry = new LinkedHashMap<>();
                entry.put("rank", i + 1);
                entry.put("sourceId", hit.sourceId());
                entry.put("score", Math.round(hit.score() * 1000.0) / 1000.0);
                entry.put("citation", citationLabel);
                entry.put("metadata", citationToMap(hit.citation()));
                entry.put("content", hit.content());
                results.add(entry);

                text.append("[").append(i + 1).append("] ").append(citationLabel)
                        .append(" (score: ").append(String.format(Locale.ROOT, "%.3f", hit.score())).append(")\n")
                        .append(hit.content()).append("\n\n---\n\n");
            }
        }

        Map<String, Object> structured = new LinkedHashMap<>();
        structured.put("query", query);
        structured.put("sourceId", sourceId != null ? sourceId.toString() : null);
        structured.put("count", results.size());
        structured.put("results", results);
        return toolSuccessResult(text.toString().trim(), structured);
    }

    private Map<String, Object> executeGetSourceDetails(UUID workspaceId, Map<String, Object> args) {
        UUID sourceId = parseRequiredUuid(args.get("sourceId"), "sourceId");
        RepositoryResponse repo = repoService.getResponse(sourceId, workspaceId);
        Map<String, Object> details = summarizeSource(repo);
        details.put("description", repo.description());
        details.put("defaultBranch", repo.defaultBranch());
        details.put("language", repo.language());
        details.put("htmlUrl", repo.htmlUrl());
        details.put("fileName", repo.fileName());
        details.put("fileSizeBytes", repo.fileSizeBytes());
        details.put("unitCount", repo.pageCount() != null ? repo.pageCount() : repo.filesTotal());
        details.put("indexedAt", repo.indexedAt() != null ? repo.indexedAt().toString() : null);
        details.put("errorMessage", repo.errorMessage());

        return toolSuccessResult(toPrettyJson(details), details);
    }

    private Map<String, Object> executeGetSourceExcerpts(UUID workspaceId, Map<String, Object> args) {
        UUID sourceId = parseRequiredUuid(args.get("sourceId"), "sourceId");
        RepositoryResponse repo = repoService.getResponse(sourceId, workspaceId);
        String filePath = stringArg(args.get("filePath"));
        Integer unitNumber = args.get("unitNumber") != null ? intArg(args.get("unitNumber"), 1, 1, 100_000) : null;
        int offset = intArg(args.get("offset"), 0, 0, 100_000);
        int limit = intArg(args.get("limit"), 6, 1, 20);

        List<CodeContextRetriever.SearchHit> hits = codeContextRetriever.fetchSourceChunks(
                workspaceId, sourceId, filePath, unitNumber, offset, limit);

        List<Map<String, Object>> excerpts = new ArrayList<>(hits.size());
        StringBuilder text = new StringBuilder();
        if (hits.isEmpty()) {
            text.append("No indexed excerpts matched the specified filters for ").append(repo.fullName()).append(".");
        } else {
            text.append("Excerpts from ").append(repo.fullName()).append(" (").append(hits.size()).append(" chunk(s)):\n\n");
            for (CodeContextRetriever.SearchHit hit : hits) {
                String label = formatCitationLabel(hit.citation());
                Map<String, Object> item = new LinkedHashMap<>();
                item.put("citation", label);
                item.put("metadata", citationToMap(hit.citation()));
                item.put("content", hit.content());
                excerpts.add(item);

                text.append("### ").append(label).append("\n")
                        .append(hit.content()).append("\n\n");
            }
        }

        Map<String, Object> structured = new LinkedHashMap<>();
        structured.put("sourceId", sourceId.toString());
        structured.put("sourceName", repo.fullName());
        structured.put("offset", offset);
        structured.put("count", excerpts.size());
        structured.put("excerpts", excerpts);
        return toolSuccessResult(text.toString().trim(), structured);
    }

    private static Map<String, Object> summarizeSource(RepositoryResponse r) {
        Map<String, Object> map = new LinkedHashMap<>();
        map.put("id", r.id().toString());
        map.put("name", r.fullName());
        map.put("sourceType", (r.sourceType() != null ? r.sourceType() : SourceType.GITHUB_REPO).name());
        map.put("status", r.indexStatus().name());
        map.put("chunkCount", r.chunkCount());
        map.put("unitsTotal", r.pageCount() != null ? r.pageCount() : r.filesTotal());
        return map;
    }

    static String formatCitationLabel(CitationDto c) {
        if (c == null) return "Unknown source";
        String type = c.sourceType() != null ? c.sourceType().toUpperCase(Locale.ROOT) : "GITHUB_REPO";
        String file = c.filePath() != null ? c.filePath() : "source";
        Integer unit = c.pageNumber() != null ? c.pageNumber() : c.startLine();

        return switch (type) {
            case "PDF" -> file + (unit != null ? " · Page " + unit : "")
                    + (c.sectionHeading() != null ? " · " + c.sectionHeading() : "");
            case "EPUB" -> file + (unit != null ? " · Chapter " + unit : "")
                    + (c.sectionHeading() != null ? " · " + c.sectionHeading() : "");
            case "NOTEBOOK" -> file + (unit != null ? " · Cell " + unit : "")
                    + (c.sectionHeading() != null ? " · " + c.sectionHeading() : "");
            case "IAC" -> (c.sectionHeading() != null ? "Block: " + c.sectionHeading() : file)
                    + (unit != null ? " (Line " + unit + ")" : "");
            default -> {
                if (c.startLine() != null) {
                    String range = c.endLine() != null && !c.endLine().equals(c.startLine())
                            ? c.startLine() + "-" + c.endLine()
                            : String.valueOf(c.startLine());
                    yield file + ":" + range;
                }
                yield file;
            }
        };
    }

    private static Map<String, Object> citationToMap(CitationDto c) {
        Map<String, Object> map = new LinkedHashMap<>();
        if (c == null) return map;
        map.put("filePath", c.filePath());
        map.put("sourceType", c.sourceType());
        if (c.startLine() != null) map.put("startLine", c.startLine());
        if (c.endLine() != null) map.put("endLine", c.endLine());
        if (c.pageNumber() != null) map.put("pageNumber", c.pageNumber());
        if (c.sectionHeading() != null) map.put("sectionHeading", c.sectionHeading());
        if (c.chunkIndex() != null) map.put("chunkIndex", c.chunkIndex());
        return map;
    }

    private static Map<String, Object> toolDef(String name, String description, Map<String, Object> inputSchema) {
        Map<String, Object> def = new LinkedHashMap<>();
        def.put("name", name);
        def.put("description", description);
        def.put("inputSchema", inputSchema);
        return def;
    }

    private static Map<String, Object> schema(Map<String, Object> properties, List<String> required) {
        Map<String, Object> s = new LinkedHashMap<>();
        s.put("type", "object");
        s.put("properties", properties);
        if (required != null && !required.isEmpty()) {
            s.put("required", required);
        }
        return s;
    }

    private static Map<String, Object> toolSuccessResult(String text, Map<String, Object> structured) {
        Map<String, Object> result = new LinkedHashMap<>();
        result.put("content", List.of(Map.of("type", "text", "text", text)));
        result.put("structuredContent", structured);
        result.put("isError", false);
        return result;
    }

    private static Map<String, Object> toolErrorResult(String message) {
        Map<String, Object> result = new LinkedHashMap<>();
        result.put("content", List.of(Map.of("type", "text", "text", message)));
        result.put("isError", true);
        return result;
    }

    private static Map<String, Object> okResponse(Object id, Object result) {
        Map<String, Object> resp = new LinkedHashMap<>();
        resp.put("jsonrpc", "2.0");
        resp.put("id", id);
        resp.put("result", result);
        return resp;
    }

    private static Map<String, Object> errorResponse(Object id, int code, String message) {
        Map<String, Object> resp = new LinkedHashMap<>();
        resp.put("jsonrpc", "2.0");
        resp.put("id", id);
        resp.put("error", Map.of("code", code, "message", message));
        return resp;
    }

    private static String stringArg(Object raw) {
        return raw instanceof String s ? s.trim() : null;
    }

    private static UUID parseRequiredUuid(Object raw, String field) {
        UUID parsed = parseOptionalUuid(raw, field);
        if (parsed == null) {
            throw new IllegalArgumentException("Missing required UUID parameter: " + field);
        }
        return parsed;
    }

    private static UUID parseOptionalUuid(Object raw, String field) {
        if (raw == null) return null;
        String str = String.valueOf(raw).trim();
        if (str.isEmpty()) return null;
        try {
            return UUID.fromString(str);
        } catch (IllegalArgumentException e) {
            throw new IllegalArgumentException("Invalid UUID for parameter '" + field + "'");
        }
    }

    private static int intArg(Object raw, int fallback, int min, int max) {
        if (raw == null) return fallback;
        int val;
        if (raw instanceof Number n) {
            val = n.intValue();
        } else {
            try {
                val = Integer.parseInt(String.valueOf(raw).trim());
            } catch (NumberFormatException e) {
                return fallback;
            }
        }
        return Math.max(min, Math.min(max, val));
    }

    private static double doubleArg(Object raw, double fallback, double min, double max) {
        if (raw == null) return fallback;
        double val;
        if (raw instanceof Number n) {
            val = n.doubleValue();
        } else {
            try {
                val = Double.parseDouble(String.valueOf(raw).trim());
            } catch (NumberFormatException e) {
                return fallback;
            }
        }
        if (Double.isNaN(val) || Double.isInfinite(val)) return fallback;
        return Math.max(min, Math.min(max, val));
    }

    private static <E extends Enum<E>> E parseOptionalEnum(Object raw, Class<E> enumClass) {
        if (raw == null) return null;
        String val = String.valueOf(raw).trim().toUpperCase(Locale.ROOT);
        if (val.isEmpty()) return null;
        try {
            return Enum.valueOf(enumClass, val);
        } catch (IllegalArgumentException e) {
            throw new IllegalArgumentException("Invalid value '" + raw + "' for " + enumClass.getSimpleName());
        }
    }

    private static String toPrettyJson(Object obj) {
        try {
            return OBJECT_MAPPER.writerWithDefaultPrettyPrinter().writeValueAsString(obj);
        } catch (Exception e) {
            return String.valueOf(obj);
        }
    }
}
