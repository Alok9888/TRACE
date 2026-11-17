package trace.backend.services.ai;

public final class RagSettings {
     /** How many code chunks to fetch from the vector database per question. */
    public static final int TOP_K_CHUNKS = 5;

    /** Minimum cosine similarity score required for a retrieved chunk to be included. */
    public static final double SIMILARITY_THRESHOLD = 0.35;

    /** Hard character budget for retrieved code context (~950 tokens) to keep total LLM input < 1200 tokens. */
    public static final int MAX_CONTEXT_CHARS = 3800;

    /** Max time (ms) to keep an SSE stream open while the model is responding. */
    public static final long STREAM_TIMEOUT_MS = 95_000L;

    /** Metadata key stored on each embedded document (must match {@link trace.backend.service.indexing.CodeChunker}). */
    public static final String METADATA_REPO_ID = "repoId";

    /** Metadata key for workspace/user ID in vector documents. */
    public static final String METADATA_USER_ID = "userId";

    private RagSettings() {
    }
}
