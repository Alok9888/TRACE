package trace.backend.services.ai;

import java.util.Locale;

/**
 * Validated, immutable per-request LLM and RAG retrieval parameters.
 * Clamped server-side so callers cannot break provider limits or degrade latency unexpectedly.
 */
public record ChatGenerationConfig(
        double temperature,
        int maxTokens,
        int topK,
        double similarityThreshold,
        String systemPrompt,
        boolean customMaxTokens,
        boolean customTopK) {

    public static final double MIN_TEMPERATURE = 0.0;
    public static final double MAX_TEMPERATURE = 1.0;
    public static final double DEFAULT_TEMPERATURE = 0.2;

    public static final int MIN_MAX_TOKENS = 256;
    public static final int MAX_MAX_TOKENS = 4096;
    public static final int DEFAULT_MAX_TOKENS = 1024;

    public static final int MIN_TOP_K = 1;
    public static final int MAX_TOP_K = 10;
    public static final int DEFAULT_TOP_K = RagSettings.TOP_K_CHUNKS;

    public static final double MIN_SIMILARITY_THRESHOLD = 0.0;
    public static final double MAX_SIMILARITY_THRESHOLD = 1.0;
    public static final double DEFAULT_SIMILARITY_THRESHOLD = RagSettings.SIMILARITY_THRESHOLD;

    public static final String DEFAULT_SYSTEM_PROMPT = "Answer from repo code only.";
    public static final String GENERIC_DEFAULT_SYSTEM_PROMPT = "Answer from indexed source content only.";
    public static final int MAX_SYSTEM_PROMPT_CHARS = 1200;

    private static final ChatGenerationConfig DEFAULTS = new ChatGenerationConfig(
            DEFAULT_TEMPERATURE,
            DEFAULT_MAX_TOKENS,
            DEFAULT_TOP_K,
            DEFAULT_SIMILARITY_THRESHOLD,
            DEFAULT_SYSTEM_PROMPT,
            false,
            false);

    public static ChatGenerationConfig defaults() {
        return DEFAULTS;
    }

    public static ChatGenerationConfig from(
            Double temperature,
            Integer maxTokens,
            Integer topK,
            Double similarityThreshold,
            String systemPrompt) {
        double temp = clampDouble(temperature, DEFAULT_TEMPERATURE, MIN_TEMPERATURE, MAX_TEMPERATURE);
        int tokens = clampInt(maxTokens, DEFAULT_MAX_TOKENS, MIN_MAX_TOKENS, MAX_MAX_TOKENS);
        int k = clampInt(topK, DEFAULT_TOP_K, MIN_TOP_K, MAX_TOP_K);
        double threshold = clampDouble(
                similarityThreshold, DEFAULT_SIMILARITY_THRESHOLD, MIN_SIMILARITY_THRESHOLD, MAX_SIMILARITY_THRESHOLD);
        String prompt = sanitizePrompt(systemPrompt);

        boolean hasCustomMaxTokens = maxTokens != null && tokens != DEFAULT_MAX_TOKENS;
        boolean hasCustomTopK = topK != null && k != DEFAULT_TOP_K;

        if (!hasCustomMaxTokens
                && !hasCustomTopK
                && Double.compare(temp, DEFAULT_TEMPERATURE) == 0
                && Double.compare(threshold, DEFAULT_SIMILARITY_THRESHOLD) == 0
                && DEFAULT_SYSTEM_PROMPT.equals(prompt)) {
            return DEFAULTS;
        }
        return new ChatGenerationConfig(temp, tokens, k, threshold, prompt, hasCustomMaxTokens, hasCustomTopK);
    }

    public boolean isDefaultSystemPrompt() {
        return isDefaultPromptString(systemPrompt);
    }

    public static boolean isDefaultPromptString(String prompt) {
        if (prompt == null || prompt.isBlank()) {
            return true;
        }
        String trimmed = prompt.trim();
        return DEFAULT_SYSTEM_PROMPT.equalsIgnoreCase(trimmed)
                || GENERIC_DEFAULT_SYSTEM_PROMPT.equalsIgnoreCase(trimmed);
    }

    /** Compact deterministic key segment so Q&A cache isolates responses across config changes. */
    public String cacheKeySegment() {
        return String.format(
                Locale.ROOT,
                "t=%.2f|m=%d|k=%d|s=%.2f|p=%x",
                temperature,
                maxTokens,
                topK,
                similarityThreshold,
                systemPrompt.hashCode());
    }

    private static double clampDouble(Double value, double fallback, double min, double max) {
        if (value == null || value.isNaN() || value.isInfinite()) {
            return fallback;
        }
        double clamped = Math.max(min, Math.min(max, value));
        return Math.round(clamped * 100.0) / 100.0;
    }

    private static int clampInt(Integer value, int fallback, int min, int max) {
        if (value == null) {
            return fallback;
        }
        return Math.max(min, Math.min(max, value));
    }

    private static String sanitizePrompt(String raw) {
        if (raw == null || raw.isBlank()) {
            return DEFAULT_SYSTEM_PROMPT;
        }
        String trimmed = raw.trim();
        if (trimmed.length() > MAX_SYSTEM_PROMPT_CHARS) {
            return trimmed.substring(0, MAX_SYSTEM_PROMPT_CHARS);
        }
        return trimmed;
    }
}
