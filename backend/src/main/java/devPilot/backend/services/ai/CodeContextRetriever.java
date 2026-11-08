package devPilot.backend.services.ai;

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

@Service
@RequiredArgsConstructor
@Slf4j
public class CodeContextRetriever {
    private static final String NO_MATCHES = "(no matching code chunks found)";
    private static final ObjectMapper OBJECT_MAPPER = new ObjectMapper();
    private static final TypeReference<Map<String, Object>> MAP_TYPE = new TypeReference<>() {};

    private final VectorStore vectorStore;
    private final CitationMapper citationMapper;
    private final JdbcTemplate jdbcTemplate;

    @Autowired(required = false)
    private EmbeddingModel embeddingModel;

    @Value("${spring.ai.vectorstore.pgvector.table-name:devpilot_vectors_cf_384}")
    private String vectorTableName = "devpilot_vectors_cf_384";

    public int embeddingDimensions() {
        return 384;
    }

    public RetrievedContext retrieve(UUID userId, UUID repositoryId, String question) {
        return retrieve(userId, repositoryId, question, RagSettings.TOP_K_CHUNKS, RagSettings.MAX_CONTEXT_CHARS);
    }

    public RetrievedContext retrieve(UUID userId, UUID repositoryId, String question, int topK, int maxContextChars) {
        long startMs = System.currentTimeMillis();
        int effectiveTopK = Math.max(1, topK);
        int effectiveMaxChars = Math.max(400, maxContextChars);

        log.info("{} [VECTOR] search start repo={} queryLength={} topK={} maxChars={} threshold={}",
                Instant.now(), repositoryId, question.length(), effectiveTopK, effectiveMaxChars, RagSettings.SIMILARITY_THRESHOLD);

        List<Document> documents;
        String mode = "vector-store";
        long embedMs = 0L;
        long dbMs = 0L;

        if (embeddingModel != null && jdbcTemplate != null) {
            try {
                long embedStart = System.currentTimeMillis();
                float[] queryVector = embeddingModel.embed(question);
                embedMs = System.currentTimeMillis() - embedStart;

                long dbStart = System.currentTimeMillis();
                documents = directIndexedVectorSearch(userId, repositoryId, queryVector, effectiveTopK);
                dbMs = System.currentTimeMillis() - dbStart;
                mode = "direct-sql";
            } catch (RuntimeException directError) {
                log.warn("{} [VECTOR] direct indexed SQL failed repo={}, falling back to VectorStore: {}",
                        Instant.now(), repositoryId, directError.getMessage());
                documents = searchViaVectorStore(userId, repositoryId, question, effectiveTopK);
            }
        } else {
            documents = searchViaVectorStore(userId, repositoryId, question, effectiveTopK);
        }

        if (documents == null) {
            documents = List.of();
        }
        int rawCount = documents.size();
        List<Document> filtered = documents.stream()
                .filter(doc -> doc.getScore() == null || doc.getScore() >= RagSettings.SIMILARITY_THRESHOLD)
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
                selected.size(), rawCount, RagSettings.SIMILARITY_THRESHOLD, estContextTokens);

        return new RetrievedContext(citations, contextText);
    }

    /**
     * Queries PgVector directly using the B-tree expression index on ((metadata->>'repoId'), (metadata->>'userId')).
     * Avoids Spring AI's `metadata::jsonb @@` cast across all rows and ANTLR filter parsing.
     */
    private List<Document> directIndexedVectorSearch(UUID userId, UUID repositoryId, float[] queryVector, int topK) {
        String vectorLiteral = toPgVectorLiteral(queryVector);
        double maxDistance = 1.0 - RagSettings.SIMILARITY_THRESHOLD;
        String table = (vectorTableName == null || vectorTableName.isBlank()) ? "devpilot_vectors_cf_384" : vectorTableName;

        String sql = "SELECT content, metadata::text AS metadata_json, (1 - (embedding <=> ?::vector)) AS score "
                + "FROM " + table + " "
                + "WHERE (metadata->>'repoId') = ? "
                + "  AND (metadata->>'userId') = ? "
                + "  AND (embedding <=> ?::vector) <= ? "
                + "ORDER BY embedding <=> ?::vector ASC "
                + "LIMIT ?";

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
                vectorLiteral,
                maxDistance,
                vectorLiteral,
                topK);
    }

    private List<Document> searchViaVectorStore(UUID userId, UUID repositoryId, String question, int topK) {
        String filterExpression = RagSettings.METADATA_REPO_ID + " == '" + repositoryId
                + "' && " + RagSettings.METADATA_USER_ID + " == '" + userId + "'";

        var search = SearchRequest.builder()
                .query(question)
                .topK(topK)
                .similarityThreshold(RagSettings.SIMILARITY_THRESHOLD)
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
