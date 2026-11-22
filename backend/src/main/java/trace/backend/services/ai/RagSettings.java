package trace.backend.services.ai;

public final class RagSettings {
     /** How many chunks to fetch from the vector database per question. */
    public static final int TOP_K_CHUNKS = 5;

    /** Minimum cosine similarity score required for a retrieved chunk to be included. */
    public static final double SIMILARITY_THRESHOLD = 0.35;

    /** Hard character budget for retrieved context (~950 tokens) to keep total LLM input < 1200 tokens. */
    public static final int MAX_CONTEXT_CHARS = 3800;

    /** Max time (ms) to keep an SSE stream open while the model is responding. */
    public static final long STREAM_TIMEOUT_MS = 95_000L;

    /** Metadata key stored on each embedded document (source/repository UUID). */
    public static final String METADATA_REPO_ID = "repoId";

    /** Metadata key for workspace/user ID in vector documents. */
    public static final String METADATA_USER_ID = "userId";

    /** Metadata key identifying source discriminator (GITHUB_REPO or PDF). */
    public static final String METADATA_SOURCE_TYPE = "sourceType";

    /** Metadata key for 1-based PDF page number. */
    public static final String METADATA_PAGE_NUMBER = "pageNumber";

    /** Metadata key for detected PDF section heading. */
    public static final String METADATA_SECTION_HEADING = "sectionHeading";

    private RagSettings() {
    }
}
