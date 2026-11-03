package devPilot.backend.config;

import java.util.concurrent.Executor;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
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
            .initializeSchema(false)
            .build();
    }

    /**
     * Ensures vector HNSW and JSONB metadata filter indexes exist on Postgres/Neon asynchronously
     * so filtered similarity search and incremental file deletes never fall back to full table scans.
     */
    @Bean
    ApplicationRunner vectorIndexInitializer(
            JdbcTemplate jdbcTemplate,
            @Qualifier("ioExecutor") Executor ioExecutor) {
        return args -> ioExecutor.execute(() -> ensureVectorIndexes(jdbcTemplate));
    }

    private void ensureVectorIndexes(JdbcTemplate jdbcTemplate) {
        String[] statements = {
            "CREATE INDEX IF NOT EXISTS idx_vectors_cf384_embedding_hnsw ON " + VECTOR_TABLE
                + " USING hnsw (embedding vector_cosine_ops)",
            "CREATE INDEX IF NOT EXISTS idx_vectors_cf384_metadata_gin ON " + VECTOR_TABLE
                + " USING gin (metadata jsonb_path_ops)",
            "CREATE INDEX IF NOT EXISTS idx_vectors_cf384_repo_user ON " + VECTOR_TABLE
                + " ((metadata->>'repoId'), (metadata->>'userId'))",
            "CREATE INDEX IF NOT EXISTS idx_vectors_cf384_repo_filepath ON " + VECTOR_TABLE
                + " ((metadata->>'repoId'), (metadata->>'filePath'))"
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
}