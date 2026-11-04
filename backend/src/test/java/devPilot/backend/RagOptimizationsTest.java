package devPilot.backend;

import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.*;

import java.lang.reflect.Method;
import java.util.List;
import java.util.Map;
import java.util.UUID;

import org.junit.jupiter.api.Test;
import org.mockito.ArgumentCaptor;
import org.springframework.ai.document.Document;
import org.springframework.ai.embedding.EmbeddingModel;
import org.springframework.ai.vectorstore.SearchRequest;
import org.springframework.ai.vectorstore.VectorStore;
import org.springframework.ai.vectorstore.filter.Filter;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.util.ReflectionTestUtils;

import devPilot.backend.config.EmbeddingConfig;
import devPilot.backend.repository.RepositoryRepository;
import devPilot.backend.services.ai.CitationMapper;
import devPilot.backend.services.ai.CodeContextRetriever;
import devPilot.backend.services.ai.RagSettings;
import devPilot.backend.services.embedding.CloudflareEmbeddingService;
import devPilot.backend.services.github.GitHubRateLimiter;
import devPilot.backend.services.github.GithubApiClient;
import devPilot.backend.services.indexing.CodeChunker;
import devPilot.backend.services.indexing.CodeFileFilter;
import devPilot.backend.services.indexing.IndexingService;

class RagOptimizationsTest {

    @Test
    void filterSkipsJunkAndOversizedBlobsBeforeFetch() throws Exception {
        CodeFileFilter filter = new CodeFileFilter();
        IndexingService service = new IndexingService(
                mock(RepositoryRepository.class),
                mock(GithubApiClient.class),
                filter,
                new CodeChunker(1600, filter),
                new GitHubRateLimiter(0),
                mock(VectorStore.class),
                mock(EmbeddingModel.class)
        );
        ReflectionTestUtils.setField(service, "maxFileBytes", 102400L);

        Map<String, Object> tree = Map.of("tree", List.of(
                Map.of("type", "blob", "path", "index.js", "sha", "s1", "size", 4200),
                Map.of("type", "blob", "path", "index.d.ts", "sha", "s2", "size", 3100),
                Map.of("type", "blob", "path", "readme.md", "sha", "s3", "size", 5000),
                Map.of("type", "blob", "path", "package.json", "sha", "s4", "size", 1200),
                Map.of("type", "blob", "path", "package-lock.json", "sha", "s5", "size", 80000),
                Map.of("type", "blob", "path", "node_modules/chalk/index.js", "sha", "s6", "size", 2000),
                Map.of("type", "blob", "path", "dist/bundle.js", "sha", "s7", "size", 2000),
                Map.of("type", "blob", "path", ".gitignore", "sha", "s8", "size", 200),
                Map.of("type", "blob", "path", ".github/workflows/main.yml", "sha", "s9", "size", 500),
                Map.of("type", "blob", "path", "screenshot.png", "sha", "s10", "size", 45000),
                Map.of("type", "blob", "path", "big-file.js", "sha", "s11", "size", 150000),
                Map.of("type", "blob", "path", "vendor.min.js", "sha", "s12", "size", 10000),
                Map.of("type", "tree", "path", "src", "sha", "t1")
        ));

        Method extractMethod = IndexingService.class.getDeclaredMethod("extractFileShas", Map.class);
        extractMethod.setAccessible(true);
        @SuppressWarnings("unchecked")
        Map<String, String> eligible = (Map<String, String>) extractMethod.invoke(service, tree);

        assertEquals(4, eligible.size());
        assertTrue(eligible.containsKey("index.js"));
        assertTrue(eligible.containsKey("index.d.ts"));
        assertTrue(eligible.containsKey("readme.md"));
        assertTrue(eligible.containsKey("package.json"));
    }

    @Test
    void deleteVectorsForRemovedFilesFiltersByFilePath() throws Exception {
        VectorStore vectorStore = mock(VectorStore.class);
        CodeFileFilter filter = new CodeFileFilter();
        IndexingService service = new IndexingService(
                mock(RepositoryRepository.class),
                mock(GithubApiClient.class),
                filter,
                new CodeChunker(1600, filter),
                new GitHubRateLimiter(0),
                vectorStore,
                mock(EmbeddingModel.class)
        );

        UUID userId = UUID.randomUUID();
        String repoId = UUID.randomUUID().toString();

        Method deleteMethod = IndexingService.class.getDeclaredMethod(
                "deleteVectorsForRemovedFiles", UUID.class, String.class, List.class);
        deleteMethod.setAccessible(true);
        deleteMethod.invoke(service, userId, repoId, List.of("src/removed.js"));

        ArgumentCaptor<Filter.Expression> captor = ArgumentCaptor.forClass(Filter.Expression.class);
        verify(vectorStore, times(1)).delete(captor.capture());
        verify(vectorStore, never()).similaritySearch(any(SearchRequest.class));

        String exprString = captor.getValue().toString();
        assertTrue(exprString.contains("repoId"), "Filter must contain repoId: " + exprString);
        assertTrue(exprString.contains("userId"), "Filter must contain userId: " + exprString);
        assertTrue(exprString.contains("filePath"), "Filter must contain filePath: " + exprString);
        assertTrue(exprString.contains("src/removed.js"), "Filter must contain target filePath: " + exprString);
    }

    @Test
    void chunkerUses1600CharsAddsHeaderToEveryChunkAndPopulatesLineNumbers() {
        CodeFileFilter filter = new CodeFileFilter();
        CodeChunker oldChunker = new CodeChunker(800, filter);
        CodeChunker newChunker = new CodeChunker(1600, filter);

        StringBuilder sb = new StringBuilder();
        for (int line = 1; line <= 200; line++) {
            sb.append("export function boxenHelper").append(line)
              .append("(input, options) { return input.repeat(2) + options.padding; }\n");
        }
        String sampleCode = sb.toString();

        UUID userId = UUID.randomUUID();
        String repoId = UUID.randomUUID().toString();
        List<Document> oldChunks = oldChunker.chunkFile(userId, repoId, "index.js", sampleCode);
        List<Document> newChunks = newChunker.chunkFile(userId, repoId, "index.js", sampleCode);

        assertTrue(newChunks.size() >= 2, "Expected multiple chunks for 200-line sample");
        assertTrue(newChunks.size() <= (oldChunks.size() + 1) / 2 + 1,
                "1600-char chunker should produce ~half as many chunks: old=" + oldChunks.size() + " new=" + newChunks.size());

        for (int i = 0; i < newChunks.size(); i++) {
            Document doc = newChunks.get(i);
            assertTrue(doc.getText().startsWith("// File: index.js\n"),
                    "Chunk " + i + " must start with // File: header");
            Integer startLine = (Integer) doc.getMetadata().get("startLine");
            Integer endLine = (Integer) doc.getMetadata().get("endLine");
            assertNotNull(startLine, "startLine must be populated on chunk " + i);
            assertNotNull(endLine, "endLine must be populated on chunk " + i);
            assertTrue(startLine >= 1 && endLine >= startLine && endLine <= 201,
                    "Invalid line range on chunk " + i + ": " + startLine + "-" + endLine);
        }
    }

    @Test
    void cloudflareCacheAndStatusParsingWorkWithoutZeroVectors() throws Exception {
        CloudflareEmbeddingService service = new CloudflareEmbeddingService(mock(JdbcTemplate.class));
        assertEquals(384, service.dimensions());

        // Status parsing
        Method extractStatus = CloudflareEmbeddingService.class.getDeclaredMethod("extractHttpStatus", Throwable.class);
        extractStatus.setAccessible(true);
        assertEquals(429, extractStatus.invoke(service, new RuntimeException("Cloudflare embedding API call failed: HTTP 429: rate limited")));
        assertEquals(401, extractStatus.invoke(service, new RuntimeException("HTTP 401: unauthorized")));
        assertEquals(400, extractStatus.invoke(service, new RuntimeException("HTTP 400: bad request")));
        assertEquals(503, extractStatus.invoke(service, new RuntimeException("HTTP 503: unavailable")));
        assertEquals(0, extractStatus.invoke(service, new RuntimeException("Connection reset")));

        // Zero vectors rejected by cache
        float[] zeros = new float[384];
        service.putCachedEmbedding("zero-key", zeros);
        assertNull(service.getCachedEmbedding("zero-key"));

        // Non-zero vector cached and returned without Cloudflare API call
        float[] valid = new float[384];
        valid[0] = 0.5f;
        service.putCachedEmbedding("how does boxen handle padding?", valid);
        float[] hit = service.embed("how does boxen handle padding?");
        assertSame(valid, hit);
        assertEquals(0L, service.getApiCallCount());
        assertEquals(1L, service.getCacheHitCount());
        assertEquals(100.0, service.getCacheHitRate(), 0.01);
    }

    @Test
    void retrieverEnforcesTop5SimilarityThreshold035AndInputTokenBudget() {
        assertEquals(5, RagSettings.TOP_K_CHUNKS);
        assertEquals(0.35, RagSettings.SIMILARITY_THRESHOLD, 0.0001);
        assertEquals(3800, RagSettings.MAX_CONTEXT_CHARS);

        VectorStore vectorStore = mock(VectorStore.class);
        CitationMapper citationMapper = mock(CitationMapper.class);
        JdbcTemplate jdbcTemplate = mock(JdbcTemplate.class);
        CodeContextRetriever retriever = new CodeContextRetriever(vectorStore, citationMapper, jdbcTemplate);

        assertEquals(384, retriever.embeddingDimensions());

        String bigChunk = "// File: index.js\n" + "a".repeat(1500);
        Document good1 = Document.builder().text(bigChunk).score(0.85).build();
        Document good2 = Document.builder().text(bigChunk).score(0.75).build();
        Document good3 = Document.builder().text(bigChunk).score(0.65).build();
        Document lowDoc = Document.builder().text("// File: noise.js\nconst y = 2;").score(0.21).build();
        when(vectorStore.similaritySearch(any(SearchRequest.class))).thenReturn(List.of(good1, good2, good3, lowDoc));
        when(citationMapper.fromDocument(any())).thenReturn(
                new devPilot.backend.dto.CitationDto("index.js", 1, 10, "js"));

        var ctx = retriever.retrieve(UUID.randomUUID(), UUID.randomUUID(), "how does boxen render borders?");

        ArgumentCaptor<SearchRequest> reqCaptor = ArgumentCaptor.forClass(SearchRequest.class);
        verify(vectorStore).similaritySearch(reqCaptor.capture());
        assertEquals(5, reqCaptor.getValue().getTopK());
        assertEquals(0.35, reqCaptor.getValue().getSimilarityThreshold(), 0.0001);
        assertFalse(ctx.contextText().contains("const y = 2"), "Low-score chunk below 0.35 must be rejected");
        assertTrue(ctx.contextText().length() <= RagSettings.MAX_CONTEXT_CHARS,
                "Context must stay within budget: " + ctx.contextText().length());
    }

    @Test
    void batchingStrategyPreservesFull64ChunkBatchesWithoutTokenFragmentation() {
        List<Document> docs64 = new java.util.ArrayList<>(64);
        String body = "// File: src/app.ts\n" + "export const value = computeSomething(a, b);\n".repeat(35);
        for (int i = 0; i < 64; i++) {
            docs64.add(new Document(body));
        }

        List<List<Document>> singleBatch = EmbeddingConfig.fixedSizeBatches(docs64);
        assertEquals(1, singleBatch.size(), "64 code chunks must stay in 1 batch (not split into 18-22)");
        assertEquals(64, singleBatch.get(0).size());

        // Simulate 1934 chunks -> 30 batches of 64 + 1 remainder of 14 = 31 calls
        List<Document> docs1934 = new java.util.ArrayList<>(1934);
        for (int i = 0; i < 1934; i++) {
            docs1934.add(new Document(body));
        }
        List<List<Document>> batches = EmbeddingConfig.fixedSizeBatches(docs1934);
        assertEquals(31, batches.size(), "1934 chunks must produce ceil(1934/64) = 31 batches");
        for (int i = 0; i < 30; i++) {
            assertEquals(64, batches.get(i).size());
        }
        assertEquals(14, batches.get(30).size());
    }
}
