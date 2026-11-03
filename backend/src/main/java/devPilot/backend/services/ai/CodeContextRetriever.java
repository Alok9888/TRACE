package devPilot.backend.services.ai;

import java.time.Instant;
import java.util.UUID;
import java.util.stream.Collectors;

import org.springframework.ai.document.Document;
import org.springframework.ai.vectorstore.SearchRequest;
import org.springframework.ai.vectorstore.VectorStore;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;

import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;

@Service
@RequiredArgsConstructor
@Slf4j
public class CodeContextRetriever {
    private static final String NO_MATCHES = "(no matching code chunks found)";

    private final VectorStore vectorStore;
    private final CitationMapper citationMapper;
    private final JdbcTemplate jdbcTemplate;

    public int embeddingDimensions() {
        return 384;
    }

    public RetrievedContext retrieve(UUID userId, UUID repositoryId, String question) {
        log.info("{} [VECTOR] search start repo={} queryLength={} topK={} threshold={}",
                Instant.now(), repositoryId, question.length(), RagSettings.TOP_K_CHUNKS, RagSettings.SIMILARITY_THRESHOLD);

        // Build filter expression as string - compatible with Spring AI 2.0.0 PGVector
        String filterExpression = RagSettings.METADATA_REPO_ID + " == '" + repositoryId
                + "' && " + RagSettings.METADATA_USER_ID + " == '" + userId + "'";

        var search = SearchRequest.builder()
                .query(question)
                .topK(RagSettings.TOP_K_CHUNKS)
                .similarityThreshold(RagSettings.SIMILARITY_THRESHOLD)
                .filterExpression(filterExpression)
                .build();

        // Do NOT mutate shared singleton jdbcTemplate.setQueryTimeout(...) — that leaks onto concurrent indexing writes!
        java.util.List<Document> documents;
        try {
            documents = executeVectorSearch(search);
        } catch (RuntimeException e) {
            log.error("{} [EMBED] vector search failed repo={}: {}", Instant.now(), repositoryId, e.getMessage());
            documents = java.util.List.of();
        }
        if (documents == null) {
            documents = java.util.List.of();
        }
        int rawCount = documents.size();
        java.util.List<Document> filtered = documents.stream()
                .filter(doc -> doc.getScore() == null || doc.getScore() >= RagSettings.SIMILARITY_THRESHOLD)
                .toList();

        // Enforce strict context character budget so total LLM input stays < 1200 tokens
        java.util.List<Document> selected = new java.util.ArrayList<>();
        StringBuilder contextBuilder = new StringBuilder();
        final String separator = "\n\n---\n\n";

        for (Document doc : filtered) {
            String text = doc.getText();
            if (text == null || text.isBlank()) {
                continue;
            }
            int projected = contextBuilder.length() + (contextBuilder.isEmpty() ? 0 : separator.length()) + text.length();
            if (projected > RagSettings.MAX_CONTEXT_CHARS) {
                if (selected.isEmpty()) {
                    // Always keep the top-1 relevant chunk, truncated cleanly to budget
                    contextBuilder.append(text, 0, Math.min(text.length(), RagSettings.MAX_CONTEXT_CHARS));
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
        log.info("{} [VECTOR] found {} results (selected={}, raw={}, threshold={}) repo={} estContextTokens={}",
                Instant.now(), filtered.size(), selected.size(), rawCount, RagSettings.SIMILARITY_THRESHOLD,
                repositoryId, estContextTokens);

        return new RetrievedContext(citations, contextText);
    }

    /**
     * Executes vector similarity search without duplicating CloudflareEmbeddingService's retry loop.
     * Retries once quickly (300ms) only on transient Postgres/connection failures.
     */
    private java.util.List<Document> executeVectorSearch(SearchRequest search) {
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

    private static boolean isTransientDbError(Throwable error) {
        for (Throwable current = error; current != null; current = current.getCause()) {
            String message = String.valueOf(current.getMessage()).toLowerCase(java.util.Locale.ROOT);
            if (message.contains("connection") && (message.contains("closed") || message.contains("reset") || message.contains("timeout"))) {
                return true;
            }
        }
        return false;
    }
}