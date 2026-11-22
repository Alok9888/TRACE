package trace.backend.services.ai;

import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.UUID;

import org.springframework.ai.document.Document;
import org.springframework.ai.embedding.EmbeddingModel;
import org.springframework.ai.vectorstore.SearchRequest;
import org.springframework.ai.vectorstore.VectorStore;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;

import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.ObjectMapper;

import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import trace.backend.dto.CitationDto;

@Service
@RequiredArgsConstructor
@Slf4j
public class CodeContextRetriever {
    public record SearchHit(
            String content,
            double score,
            String sourceId,
            CitationDto citation) {}

    private static final String NO_MATCHES = "(no matching code chunks found)";
    private static final ObjectMapper OBJECT_MAPPER = new ObjectMapper();
    private static final TypeReference<Map<String, Object>> MAP_TYPE = new TypeReference<>() {};

    private final VectorStore vectorStore;
    private final CitationMapper citationMapper;
    private final JdbcTemplate jdbcTemplate;

    @Autowired(required = false)
    private EmbeddingModel embeddingModel;

    @Value("${spring.ai.vectorstore.pgvector.table-name:trace_vectors_cf_384}")
    private String vectorTableName = "trace_vectors_cf_384";

    public int embeddingDimensions() {
        return 384;
    }

    /** Computes the query embedding directly when an EmbeddingModel bean is available (used for parallel pre-embedding). */
    public float[] embedQuery(String question) {
        if (embeddingModel == null || question == null || question.isBlank()) {
            return null;
        }
        return embeddingModel.embed(question);
    }

    public RetrievedContext retrieve(UUID userId, UUID repositoryId, String question) {
        return retrieve(
                userId,
                repositoryId,
                question,
                null,
                RagSettings.TOP_K_CHUNKS,
                RagSettings.MAX_CONTEXT_CHARS,
                RagSettings.SIMILARITY_THRESHOLD);
    }

    public RetrievedContext retrieve(UUID userId, UUID repositoryId, String question, int topK, int maxContextChars) {
        return retrieve(userId, repositoryId, question, null, topK, maxContextChars, RagSettings.SIMILARITY_THRESHOLD);
    }

    public RetrievedContext retrieve(
            UUID userId,
            UUID repositoryId,
            String question,
            int topK,
            int maxContextChars,
            double similarityThreshold) {
        return retrieve(userId, repositoryId, question, null, topK, maxContextChars, similarityThreshold);
    }

    public RetrievedContext retrieve(
            UUID userId,
            UUID repositoryId,
            String question,
            float[] precomputedEmbedding,
            int topK,
            int maxContextChars,
            double similarityThreshold) {
        long startMs = System.currentTimeMillis();
        int effectiveTopK = Math.max(1, topK);
        int effectiveMaxChars = Math.max(400, maxContextChars);
        double effectiveThreshold = Math.max(0.0, Math.min(1.0, similarityThreshold));

        log.info("{} [VECTOR] search start repo={} queryLength={} topK={} maxChars={} threshold={} preEmbedded={}",
                Instant.now(), repositoryId, question.length(), effectiveTopK, effectiveMaxChars,
                effectiveThreshold, precomputedEmbedding != null);

        List<Document> documents;
        String mode = "vector-store";
        long embedMs = 0L;
        long dbMs = 0L;

        if ((precomputedEmbedding != null || embeddingModel != null) && jdbcTemplate != null) {
            try {
                float[] queryVector = precomputedEmbedding;
                if (queryVector == null) {
                    long embedStart = System.currentTimeMillis();
                    queryVector = embeddingModel.embed(question);
                    embedMs = System.currentTimeMillis() - embedStart;
                }

                long dbStart = System.currentTimeMillis();
                documents = directIndexedVectorSearch(userId, repositoryId, queryVector, effectiveTopK, effectiveThreshold);
                dbMs = System.currentTimeMillis() - dbStart;
                mode = "direct-sql";
            } catch (RuntimeException directError) {
                log.warn("{} [VECTOR] direct indexed SQL failed repo={}, falling back to VectorStore: {}",
                        Instant.now(), repositoryId, directError.getMessage());
                documents = searchViaVectorStore(userId, repositoryId, question, effectiveTopK, effectiveThreshold);
            }
        } else {
            documents = searchViaVectorStore(userId, repositoryId, question, effectiveTopK, effectiveThreshold);
        }

        if (documents == null) {
            documents = List.of();
        }
        int rawCount = documents.size();
        List<Document> filtered = documents.stream()
                .filter(doc -> doc.getScore() == null || doc.getScore() >= effectiveThreshold)
                .toList();

        // Enforce context character budget tailored to query complexity
        List<Document> selected = new ArrayList<>();
        StringBuilder contextBuilder = new StringBuilder();
        final String separator = "\n\n---\n\n";

        for (Document doc : filtered) {
            String text = doc.getText();
            if (text == null || text.isBlank()) {
                continue;
            }
            int projected = contextBuilder.length() + (contextBuilder.isEmpty() ? 0 : separator.length()) + text.length();
            if (projected > effectiveMaxChars) {
                if (selected.isEmpty()) {
                    contextBuilder.append(text, 0, Math.min(text.length(), effectiveMaxChars));
                    selected.add(doc);
                }
                break;
            }
            if (!contextBuilder.isEmpty()) {
                contextBuilder.append(separator);
            }
            contextBuilder.append(text);
            selected.add(doc);
        }

        var citations = selected.stream()
                .map(citationMapper::fromDocument)
                .distinct()
                .toList();

        var contextText = contextBuilder.toString();
        if (contextText.isBlank()) {
            contextText = NO_MATCHES;
        }

        int estContextTokens = contextText.length() / 4;
        long totalMs = System.currentTimeMillis() - startMs;
        log.info("{} [VECTOR] done mode={} repo={} embedMs={} dbMs={} totalMs={} selected={} raw={} threshold={} estContextTokens={}",
                Instant.now(), mode, repositoryId, embedMs, dbMs, totalMs,
                selected.size(), rawCount, effectiveThreshold, estContextTokens);

        return new RetrievedContext(citations, contextText);
    }

    /**
     * Queries PgVector directly using the B-tree expression index on ((metadata->>'repoId'), (metadata->>'userId')).
     * Sends the 384-dim vector parameter ONCE via a CTE, ranks only (id, dist) first, and joins back
     * so Postgres only fetches TOAST content/metadata for the final topK rows.
     */
    private List<Document> directIndexedVectorSearch(
            UUID userId,
            UUID repositoryId,
            float[] queryVector,
            int topK,
            double similarityThreshold) {
        String vectorLiteral = toPgVectorLiteral(queryVector);
        double maxDistance = 1.0 - similarityThreshold;
        String table = (vectorTableName == null || vectorTableName.isBlank()) ? "trace_vectors_cf_384" : vectorTableName;

        String sql = "WITH q AS (SELECT ?::vector AS v), "
                + "ranked AS ( "
                + "  SELECT id, (embedding <=> q.v) AS dist "
                + "  FROM " + table + ", q "
                + "  WHERE (metadata->>'repoId') = ? "
                + "    AND (metadata->>'userId') = ? "
                + "    AND (embedding <=> q.v) <= ? "
                + "  ORDER BY dist ASC "
                + "  LIMIT ? "
                + ") "
                + "SELECT t.content, t.metadata::text AS metadata_json, (1 - r.dist) AS score "
                + "FROM ranked r "
                + "JOIN " + table + " t ON t.id = r.id "
                + "ORDER BY r.dist ASC";

        return jdbcTemplate.query(
                sql,
                (rs, rowNum) -> {
                    String content = rs.getString("content");
                    String metaJson = rs.getString("metadata_json");
                    double score = rs.getDouble("score");
                    Map<String, Object> metadata = parseMetadata(metaJson);
                    return Document.builder()
                            .text(content == null ? "" : content)
                            .metadata(metadata)
                            .score(score)
                            .build();
                },
                vectorLiteral,
                repositoryId.toString(),
                userId.toString(),
                maxDistance,
                topK);
    }

    private List<Document> searchViaVectorStore(
            UUID userId,
            UUID repositoryId,
            String question,
            int topK,
            double similarityThreshold) {
        String filterExpression = RagSettings.METADATA_REPO_ID + " == '" + repositoryId
                + "' && " + RagSettings.METADATA_USER_ID + " == '" + userId + "'";

        var search = SearchRequest.builder()
                .query(question)
                .topK(topK)
                .similarityThreshold(similarityThreshold)
                .filterExpression(filterExpression)
                .build();

        try {
            return executeVectorSearch(search);
        } catch (RuntimeException e) {
            log.error("{} [EMBED] vector search failed repo={}: {}", Instant.now(), repositoryId, e.getMessage());
            return List.of();
        }
    }

    private List<Document> executeVectorSearch(SearchRequest search) {
        try {
            return vectorStore.similaritySearch(search);
        } catch (RuntimeException e) {
            if (!isTransientDbError(e)) {
                throw e;
            }
            log.warn("{} [VECTOR] transient DB search error, retrying once in 300ms: {}", Instant.now(), e.getMessage());
            try {
                Thread.sleep(300);
            } catch (InterruptedException ie) {
                Thread.currentThread().interrupt();
                throw new RuntimeException("Interrupted during vector search retry", ie);
            }
            return vectorStore.similaritySearch(search);
        }
    }

    /**
     * Strictly workspace-scoped semantic vector search for MCP tools.
     * Enforces {@code (metadata->>'userId') = ?} on every query so cross-tenant reads are impossible.
     * When {@code optionalSourceId} is null, searches across all indexed sources belonging to {@code userId}.
     */
    public List<SearchHit> searchForWorkspace(
            UUID userId,
            UUID optionalSourceId,
            String question,
            int topK,
            double similarityThreshold) {
        if (userId == null || question == null || question.isBlank()) {
            return List.of();
        }
        int effectiveTopK = Math.max(1, Math.min(15, topK));
        double effectiveThreshold = Math.max(0.0, Math.min(1.0, similarityThreshold));
        double maxDistance = 1.0 - effectiveThreshold;

        if (embeddingModel != null && jdbcTemplate != null) {
            float[] queryVector = embeddingModel.embed(question);
            String vectorLiteral = toPgVectorLiteral(queryVector);
            String table = (vectorTableName == null || vectorTableName.isBlank())
                    ? "trace_vectors_cf_384" : vectorTableName;

            if (optionalSourceId != null) {
                String sql = "WITH q AS (SELECT ?::vector AS v), "
                        + "ranked AS ( "
                        + "  SELECT id, (embedding <=> q.v) AS dist "
                        + "  FROM " + table + ", q "
                        + "  WHERE (metadata->>'repoId') = ? "
                        + "    AND (metadata->>'userId') = ? "
                        + "    AND (embedding <=> q.v) <= ? "
                        + "  ORDER BY dist ASC "
                        + "  LIMIT ? "
                        + ") "
                        + "SELECT t.content, t.metadata::text AS metadata_json, (1 - r.dist) AS score "
                        + "FROM ranked r "
                        + "JOIN " + table + " t ON t.id = r.id "
                        + "ORDER BY r.dist ASC";
                return jdbcTemplate.query(
                        sql,
                        (rs, rowNum) -> mapSearchHit(rs.getString("content"), rs.getString("metadata_json"), rs.getDouble("score")),
                        vectorLiteral,
                        optionalSourceId.toString(),
                        userId.toString(),
                        maxDistance,
                        effectiveTopK);
            }

            String sql = "WITH q AS (SELECT ?::vector AS v), "
                    + "ranked AS ( "
                    + "  SELECT id, (embedding <=> q.v) AS dist "
                    + "  FROM " + table + ", q "
                    + "  WHERE (metadata->>'userId') = ? "
                    + "    AND (embedding <=> q.v) <= ? "
                    + "  ORDER BY dist ASC "
                    + "  LIMIT ? "
                    + ") "
                    + "SELECT t.content, t.metadata::text AS metadata_json, (1 - r.dist) AS score "
                    + "FROM ranked r "
                    + "JOIN " + table + " t ON t.id = r.id "
                    + "ORDER BY r.dist ASC";
            return jdbcTemplate.query(
                    sql,
                    (rs, rowNum) -> mapSearchHit(rs.getString("content"), rs.getString("metadata_json"), rs.getDouble("score")),
                    vectorLiteral,
                    userId.toString(),
                    maxDistance,
                    effectiveTopK);
        }

        // Fallback via VectorStore when direct JDBC/EmbeddingModel isn't wired
        String filterExpression = optionalSourceId != null
                ? RagSettings.METADATA_REPO_ID + " == '" + optionalSourceId + "' && "
                        + RagSettings.METADATA_USER_ID + " == '" + userId + "'"
                : RagSettings.METADATA_USER_ID + " == '" + userId + "'";
        var search = SearchRequest.builder()
                .query(question)
                .topK(effectiveTopK)
                .similarityThreshold(effectiveThreshold)
                .filterExpression(filterExpression)
                .build();
        List<Document> docs = executeVectorSearch(search);
        if (docs == null) {
            return List.of();
        }
        return docs.stream()
                .filter(d -> d.getScore() == null || d.getScore() >= effectiveThreshold)
                .map(d -> new SearchHit(
                        d.getText() == null ? "" : d.getText(),
                        d.getScore() == null ? 0.0 : d.getScore(),
                        String.valueOf(d.getMetadata().getOrDefault(RagSettings.METADATA_REPO_ID, "")),
                        citationMapper.fromDocument(d)))
                .toList();
    }

    /**
     * Retrieves ordered chunks directly from a specific owned source (by filePath, unit/page number, or offset).
     * Strictly enforces both {@code userId} and {@code repoId} tenant filters in SQL.
     */
    public List<SearchHit> fetchSourceChunks(
            UUID userId,
            UUID sourceId,
            String optionalFilePath,
            Integer optionalUnitNumber,
            int offset,
            int limit) {
        if (userId == null || sourceId == null || jdbcTemplate == null) {
            return List.of();
        }
        int safeLimit = Math.max(1, Math.min(20, limit));
        int safeOffset = Math.max(0, offset);
        String table = (vectorTableName == null || vectorTableName.isBlank())
                ? "trace_vectors_cf_384" : vectorTableName;

        StringBuilder sql = new StringBuilder();
        List<Object> params = new ArrayList<>();
        sql.append("SELECT content, metadata::text AS metadata_json FROM ").append(table)
                .append(" WHERE (metadata->>'repoId') = ? AND (metadata->>'userId') = ? ");
        params.add(sourceId.toString());
        params.add(userId.toString());

        if (optionalFilePath != null && !optionalFilePath.isBlank()) {
            sql.append(" AND (metadata->>'filePath') = ? ");
            params.add(optionalFilePath.trim());
        }
        if (optionalUnitNumber != null && optionalUnitNumber > 0) {
            sql.append(" AND ((metadata->>'pageNumber') = ? OR (metadata->>'startLine') = ?) ");
            String unitStr = String.valueOf(optionalUnitNumber);
            params.add(unitStr);
            params.add(unitStr);
        }

        sql.append(" ORDER BY COALESCE(NULLIF(metadata->>'chunkIndex', '')::int, 0) ASC LIMIT ? OFFSET ?");
        params.add(safeLimit);
        params.add(safeOffset);

        return jdbcTemplate.query(
                sql.toString(),
                (rs, rowNum) -> mapSearchHit(rs.getString("content"), rs.getString("metadata_json"), 1.0),
                params.toArray());
    }

    private SearchHit mapSearchHit(String content, String metaJson, double score) {
        Map<String, Object> metadata = parseMetadata(metaJson);
        Document doc = Document.builder()
                .text(content == null ? "" : content)
                .metadata(metadata)
                .score(score)
                .build();
        String sourceId = metadata.get(RagSettings.METADATA_REPO_ID) != null
                ? String.valueOf(metadata.get(RagSettings.METADATA_REPO_ID))
                : "";
        return new SearchHit(content == null ? "" : content, score, sourceId, citationMapper.fromDocument(doc));
    }

    private static String toPgVectorLiteral(float[] vector) {
        StringBuilder sb = new StringBuilder(vector.length * 10 + 2);
        sb.append('[');
        for (int i = 0; i < vector.length; i++) {
            if (i > 0) sb.append(',');
            sb.append(vector[i]);
        }
        sb.append(']');
        return sb.toString();
    }

    private static Map<String, Object> parseMetadata(String metaJson) {
        if (metaJson == null || metaJson.isBlank()) {
            return Map.of();
        }
        try {
            return OBJECT_MAPPER.readValue(metaJson, MAP_TYPE);
        } catch (Exception e) {
            return Map.of();
        }
    }

    private static boolean isTransientDbError(Throwable error) {
        for (Throwable current = error; current != null; current = current.getCause()) {
            String message = String.valueOf(current.getMessage()).toLowerCase(Locale.ROOT);
            if (message.contains("connection") && (message.contains("closed") || message.contains("reset") || message.contains("timeout"))) {
                return true;
            }
        }
        return false;
    }
}
