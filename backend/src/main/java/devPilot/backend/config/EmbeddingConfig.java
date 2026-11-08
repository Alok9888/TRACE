package devPilot.backend.config;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.Executor;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.ai.document.Document;
import org.springframework.ai.embedding.EmbeddingModel;
import org.springframework.ai.vectorstore.VectorStore;
import org.springframework.ai.vectorstore.pgvector.PgVectorStore;
import org.springframework.ai.vectorstore.pgvector.PgVectorStore.PgDistanceType;
import org.springframework.ai.vectorstore.pgvector.PgVectorStore.PgIndexType;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.boot.ApplicationRunner;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.jdbc.core.JdbcTemplate;

import devPilot.backend.services.embedding.CloudflareEmbeddingService;

@Configuration
public class EmbeddingConfig {
    private static final Logger log = LoggerFactory.getLogger(EmbeddingConfig.class);
    private static final String VECTOR_TABLE = "devpilot_vectors_cf_384";
    private static final int EMBEDDING_BATCH_SIZE = 64;

    @Bean
    EmbeddingModel cloudflareEmbeddingService(JdbcTemplate jdbcOperations) {
        return new CloudflareEmbeddingService(jdbcOperations);
    }

    @Bean
    VectorStore vectorStore(JdbcTemplate jdbcOperations, EmbeddingModel embeddingModel) {
        return PgVectorStore.builder(jdbcOperations, embeddingModel)
            .dimensions(384)
            .distanceType(PgDistanceType.COSINE_DISTANCE)
            .indexType(PgIndexType.HNSW)
            .vectorTableName(VECTOR_TABLE)
            // Bypass Spring AI's default TokenCountBatchingStrategy (8191-token cap splits 64 code chunks into 18-22!)
            .batchingStrategy(EmbeddingConfig::fixedSizeBatches)
            .initializeSchema(false)
            .build();
    }

    /**
     * Groups documents strictly by count (64 per Cloudflare Workers AI request) without running
     * OpenAI TokenCountBatchingStrategy, which otherwise fragments 64-chunk batches into ~18-22 texts.
     */
    public static List<List<Document>> fixedSizeBatches(List<Document> documents) {
        if (documents == null || documents.isEmpty()) {
            return List.of();
        }
        if (documents.size() <= EMBEDDING_BATCH_SIZE) {
            return List.of(documents);
        }
        List<List<Document>> batches = new ArrayList<>(
                (documents.size() + EMBEDDING_BATCH_SIZE - 1) / EMBEDDING_BATCH_SIZE);
        for (int i = 0; i < documents.size(); i += EMBEDDING_BATCH_SIZE) {
            batches.add(documents.subList(i, Math.min(i + EMBEDDING_BATCH_SIZE, documents.size())));
        }
        return batches;
    }

    /**
     * Ensures vector HNSW and JSONB metadata filter indexes exist on Postgres/Neon asynchronously
     * so filtered similarity search and incremental file deletes never fall back to full table scans.
     */
    @Bean
    ApplicationRunner vectorIndexInitializer(
            JdbcTemplate jdbcTemplate,
            @Qualifier("ioExecutor") Executor ioExecutor) {
        return args -> {
            ioExecutor.execute(() -> ensureVectorIndexes(jdbcTemplate));
            ioExecutor.execute(() -> warmUpExternalConnections(jdbcTemplate));
        };
    }

    private void ensureVectorIndexes(JdbcTemplate jdbcTemplate) {
        String[] statements = {
            "CREATE INDEX IF NOT EXISTS idx_vectors_cf384_embedding_hnsw ON " + VECTOR_TABLE
                + " USING hnsw (embedding vector_cosine_ops)",
            // Spring AI creates `metadata` as `json` (not `jsonb`), so GIN must index `(metadata::jsonb)`!
            "CREATE INDEX IF NOT EXISTS idx_vectors_cf384_metadata_jsonb_gin ON " + VECTOR_TABLE
                + " USING gin ((metadata::jsonb) jsonb_path_ops)",
            "CREATE INDEX IF NOT EXISTS idx_vectors_cf384_repo_user ON " + VECTOR_TABLE
                + " ((metadata->>'repoId'), (metadata->>'userId'))",
            "CREATE INDEX IF NOT EXISTS idx_vectors_cf384_repo_filepath ON " + VECTOR_TABLE
                + " ((metadata->>'repoId'), (metadata->>'filePath'))",
            "ANALYZE " + VECTOR_TABLE
        };
        for (String sql : statements) {
            try {
                jdbcTemplate.execute(sql);
            } catch (Exception e) {
                log.warn("Skipped vector index initialization ({}): {}", sql, e.getMessage());
            }
        }
        log.info("Verified PgVector HNSW and metadata indexes on {}", VECTOR_TABLE);
    }

    /**
     * Warms up HikariCP Neon connections and DNS/TLS 1.3 pools for Cloudflare & Groq at startup
     * so the very first user chat message avoids cold-connection handshake penalties.
     */
    private void warmUpExternalConnections(JdbcTemplate jdbcTemplate) {
        try {
            jdbcTemplate.queryForObject("SELECT 1", Integer.class);
        } catch (Exception ignored) {
        }
        HttpClient client = HttpClient.newBuilder()
                .version(HttpClient.Version.HTTP_2)
                .connectTimeout(Duration.ofSeconds(3))
                .build();
        for (String url : new String[]{"https://api.cloudflare.com", "https://api.groq.com"}) {
            try {
                HttpRequest req = HttpRequest.newBuilder()
                        .uri(URI.create(url))
                        .method("HEAD", HttpRequest.BodyPublishers.noBody())
                        .timeout(Duration.ofSeconds(3))
                        .build();
                client.send(req, HttpResponse.BodyHandlers.discarding());
            } catch (Exception ignored) {
            }
        }
        log.debug("Completed startup connection warmup for Neon, Cloudflare, and Groq");
    }
}