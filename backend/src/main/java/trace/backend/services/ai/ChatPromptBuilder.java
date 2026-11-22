package trace.backend.services.ai;

import java.util.Locale;
import java.util.Set;
import java.util.regex.Pattern;

import org.springframework.stereotype.Component;

import trace.backend.entity.SourceType;

/**
 * Builds question-aware and source-aware prompts so response length, structure, and citation format
 * match both query complexity and active source type (GitHub repository vs. PDF document).
 */
@Component
public class ChatPromptBuilder {

    public enum QueryTier {
        TRIVIAL,  // Pure greeting / acknowledgement -> skip RAG, 1 sentence
        SIMPLE,   // Short direct lookup / factual question -> 1-3 sentences, no boilerplate headers
        STANDARD, // Focused question -> short paragraph or 3-5 tight bullets
        DEEP      // Architecture / trace / walkthrough / synthesis -> structured sections with steps
    }

    private static final Set<String> TRIVIAL_PHRASES = Set.of(
            "hi", "hello", "hey", "yo", "sup", "hola",
            "thanks", "thank you", "thx", "ty",
            "ok", "okay", "cool", "great", "nice", "got it", "bye");

    private static final Pattern DEEP_SIGNAL_PATTERN = Pattern.compile(
            "\\b(architecture|end[- ]to[- ]end|walkthrough|step[- ]by[- ]step|in detail|detailed|deep dive|"
                    + "refactor|compare|comparison|all files|every file|entire codebase|full flow|lifecycle|"
                    + "bottleneck|bottlenecks|audit|design|explain how .* works|trace the|optimize|"
                    + "summarize the entire|comprehensive summary|all sections|key findings|methodology)\\b",
            Pattern.CASE_INSENSITIVE);

    private static final Pattern STANDARD_SIGNAL_PATTERN = Pattern.compile(
            "\\b(how does|how do|why does|why is|explain|implement|fix|debug|difference between|write|add|change|summarize|list|describe)\\b",
            Pattern.CASE_INSENSITIVE);

    public QueryTier classifyQuery(String question) {
        if (question == null || question.isBlank()) {
            return QueryTier.SIMPLE;
        }
        String trimmed = question.trim();
        String normalized = trimmed.toLowerCase(Locale.ROOT).replaceAll("[!?.,]+$", "").replaceAll("\\s+", " ");
        if (TRIVIAL_PHRASES.contains(normalized)) {
            return QueryTier.TRIVIAL;
        }

        int wordCount = normalized.isEmpty() ? 0 : normalized.split(" ").length;
        int questionMarks = 0;
        for (int i = 0; i < trimmed.length(); i++) {
            if (trimmed.charAt(i) == '?') {
                questionMarks++;
            }
        }

        if (DEEP_SIGNAL_PATTERN.matcher(trimmed).find() || wordCount >= 26 || questionMarks >= 2) {
            return QueryTier.DEEP;
        }
        if (wordCount <= 10 && !STANDARD_SIGNAL_PATTERN.matcher(trimmed).find()) {
            return QueryTier.SIMPLE;
        }
        if (wordCount <= 6) {
            return QueryTier.SIMPLE;
        }
        return QueryTier.STANDARD;
    }

    public String systemPrompt(String sourceName) {
        return systemPrompt(sourceName, SourceType.GITHUB_REPO, QueryTier.STANDARD, ChatGenerationConfig.DEFAULT_SYSTEM_PROMPT);
    }

    public String systemPrompt(String sourceName, QueryTier tier) {
        return systemPrompt(sourceName, SourceType.GITHUB_REPO, tier, ChatGenerationConfig.DEFAULT_SYSTEM_PROMPT);
    }

    public String systemPrompt(String sourceName, QueryTier tier, String customSystemPrompt) {
        return systemPrompt(sourceName, SourceType.GITHUB_REPO, tier, customSystemPrompt);
    }

    public String systemPrompt(String sourceName, SourceType sourceType, QueryTier tier, String customSystemPrompt) {
        SourceType effectiveType = sourceType != null ? sourceType : SourceType.GITHUB_REPO;
        String basePrompt = effectiveType == SourceType.PDF
                ? buildPdfBasePrompt(sourceName, tier)
                : buildRepoBasePrompt(sourceName, tier);

        boolean isDefault = ChatGenerationConfig.isDefaultPromptString(customSystemPrompt);
        String trimmedDirective = customSystemPrompt == null || customSystemPrompt.isBlank()
                ? ChatGenerationConfig.GENERIC_DEFAULT_SYSTEM_PROMPT
                : customSystemPrompt.trim();

        if (tier == QueryTier.TRIVIAL) {
            if (isDefault) {
                return basePrompt;
            }
            return basePrompt + "\nUSER INSTRUCTION: " + trimmedDirective + "\n";
        }

        if (isDefault) {
            if (effectiveType == SourceType.PDF) {
                return basePrompt
                        + "\nGROUNDING RULE: Answer strictly from the indexed document content."
                        + " If the retrieved passages do not contain the answer, state clearly that it is not present in the indexed PDF rather than guessing.\n";
            }
            return basePrompt
                    + "\nGROUNDING RULE: Answer strictly from the indexed source content."
                    + " If the retrieved code context does not contain the answer, state clearly that it is not present in the indexed repository rather than guessing.\n";
        }

        if (effectiveType == SourceType.PDF) {
            return basePrompt
                    + "\nUSER INSTRUCTION (prioritize this tone, framing, and focus): " + trimmedDirective
                    + "\nGround claims in the provided document passages when available, and cite page numbers (e.g., Page 4) and section headings.\n";
        }
        return basePrompt
                + "\nUSER INSTRUCTION (prioritize this tone, framing, and focus): " + trimmedDirective
                + "\nGround claims in the provided code context when available, and cite file paths and line ranges.\n";
    }

    private static String buildRepoBasePrompt(String repositoryFullName, QueryTier tier) {
        return switch (tier) {
            case TRIVIAL -> """
                    You are TRACE, a concise technical assistant for the %s codebase.
                    Reply in 1 brief sentence. Do not invent code details.
                    """.formatted(repositoryFullName);
            case SIMPLE -> """
                    You are TRACE, a concise technical assistant for the %s codebase.
                    RESPONSE STYLE: Answer directly in 1 to 3 short sentences of plain prose.
                    Do NOT use markdown headings, multi-section templates, or bullet lists unless explicitly requested.
                    Cite exact file paths and line ranges inline when referencing code.
                    """.formatted(repositoryFullName);
            case STANDARD -> """
                    You are TRACE, a concise technical assistant for the %s codebase.
                    RESPONSE STYLE: Match length to the question—use a short paragraph or 3 to 5 tight bullets.
                    Avoid filler introductions, redundant summaries, and unnecessary headings.
                    Cite exact file paths and line ranges inline. Include code only when directly helpful.
                    """.formatted(repositoryFullName);
            case DEEP -> """
                    You are TRACE, an expert technical assistant for the %s codebase.
                    RESPONSE STYLE: Provide a clear, structured technical breakdown with concise headings or numbered steps.
                    Cite exact file paths and line ranges throughout. Keep every point concrete and free of filler.
                    """.formatted(repositoryFullName);
        };
    }

    private static String buildPdfBasePrompt(String documentName, QueryTier tier) {
        return switch (tier) {
            case TRIVIAL -> """
                    You are TRACE, a concise document analyst for the PDF "%s".
                    Reply in 1 brief sentence. Do not invent document facts.
                    """.formatted(documentName);
            case SIMPLE -> """
                    You are TRACE, a concise document analyst for the PDF "%s".
                    RESPONSE STYLE: Answer directly in 1 to 3 short sentences of plain prose.
                    Do NOT use markdown headings, multi-section templates, or bullet lists unless explicitly requested.
                    Cite exact page numbers (e.g., Page 3) and section headings inline when referencing facts.
                    """.formatted(documentName);
            case STANDARD -> """
                    You are TRACE, a concise document analyst for the PDF "%s".
                    RESPONSE STYLE: Match length to the question—use a short paragraph or 3 to 5 tight bullets.
                    Avoid filler introductions, redundant summaries, and unnecessary headings.
                    Cite exact page numbers (e.g., Page 4) and section headings inline for every key claim.
                    """.formatted(documentName);
            case DEEP -> """
                    You are TRACE, an expert document analyst for the PDF "%s".
                    RESPONSE STYLE: Provide a clear, structured breakdown with concise headings or numbered points.
                    Cite exact page numbers (e.g., Page 7) and section headings throughout. Keep every point concrete and free of filler.
                    """.formatted(documentName);
        };
    }

    public String userPrompt(String context, String question) {
        return userPrompt(context, question, SourceType.GITHUB_REPO);
    }

    public String userPrompt(String context, String question, SourceType sourceType) {
        String label = sourceType == SourceType.PDF ? "Document context:" : "Code context:";
        return """
                %s
                %s

                User question:
                %s
                """.formatted(label, context, question);
    }
}
