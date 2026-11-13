package devPilot.backend.services.ai;

import java.util.Locale;
import java.util.Set;
import java.util.regex.Pattern;

import org.springframework.stereotype.Component;

/**
 * Builds question-aware prompts so response length and structure match the complexity of the user's question.
 */
@Component
public class ChatPromptBuilder {

    public enum QueryTier {
        TRIVIAL,  // Pure greeting / acknowledgement -> skip RAG, 1 sentence
        SIMPLE,   // Short direct lookup / factual question -> 1-3 sentences, no boilerplate headers
        STANDARD, // Focused code question -> short paragraph or 3-5 tight bullets
        DEEP      // Architecture / trace / walkthrough / refactor -> structured sections with steps
    }

    private static final Set<String> TRIVIAL_PHRASES = Set.of(
            "hi", "hello", "hey", "yo", "sup", "hola",
            "thanks", "thank you", "thx", "ty",
            "ok", "okay", "cool", "great", "nice", "got it", "bye");

    private static final Pattern DEEP_SIGNAL_PATTERN = Pattern.compile(
            "\\b(architecture|end[- ]to[- ]end|walkthrough|step[- ]by[- ]step|in detail|detailed|deep dive|"
                    + "refactor|compare|comparison|all files|every file|entire codebase|full flow|lifecycle|"
                    + "bottleneck|bottlenecks|audit|design|explain how .* works|trace the|optimize)\\b",
            Pattern.CASE_INSENSITIVE);

    private static final Pattern STANDARD_SIGNAL_PATTERN = Pattern.compile(
            "\\b(how does|how do|why does|why is|explain|implement|fix|debug|difference between|write|add|change)\\b",
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

    public String systemPrompt(String repositoryFullName) {
        return systemPrompt(repositoryFullName, QueryTier.STANDARD, ChatGenerationConfig.DEFAULT_SYSTEM_PROMPT);
    }

    public String systemPrompt(String repositoryFullName, QueryTier tier) {
        return systemPrompt(repositoryFullName, tier, ChatGenerationConfig.DEFAULT_SYSTEM_PROMPT);
    }

    public String systemPrompt(String repositoryFullName, QueryTier tier, String customSystemPrompt) {
        String basePrompt = switch (tier) {
            case TRIVIAL -> """
                    You are DevPilot, a concise technical assistant for the %s codebase.
                    Reply in 1 brief sentence. Do not invent code details.
                    """.formatted(repositoryFullName);
            case SIMPLE -> """
                    You are DevPilot, a concise technical assistant for the %s codebase.
                    RESPONSE STYLE: Answer directly in 1 to 3 short sentences of plain prose.
                    Do NOT use markdown headings, multi-section templates, or bullet lists unless explicitly requested.
                    Cite exact file paths and line ranges inline when referencing code.
                    """.formatted(repositoryFullName);
            case STANDARD -> """
                    You are DevPilot, a concise technical assistant for the %s codebase.
                    RESPONSE STYLE: Match length to the question—use a short paragraph or 3 to 5 tight bullets.
                    Avoid filler introductions, redundant summaries, and unnecessary headings.
                    Cite exact file paths and line ranges inline. Include code only when directly helpful.
                    """.formatted(repositoryFullName);
            case DEEP -> """
                    You are DevPilot, an expert technical assistant for the %s codebase.
                    RESPONSE STYLE: Provide a clear, structured technical breakdown with concise headings or numbered steps.
                    Cite exact file paths and line ranges throughout. Keep every point concrete and free of filler.
                    """.formatted(repositoryFullName);
        };

        String trimmedDirective = customSystemPrompt == null || customSystemPrompt.isBlank()
                ? ChatGenerationConfig.DEFAULT_SYSTEM_PROMPT
                : customSystemPrompt.trim();

        if (tier == QueryTier.TRIVIAL) {
            if (ChatGenerationConfig.DEFAULT_SYSTEM_PROMPT.equalsIgnoreCase(trimmedDirective)) {
                return basePrompt;
            }
            return basePrompt + "\nUSER INSTRUCTION: " + trimmedDirective + "\n";
        }

        if (ChatGenerationConfig.DEFAULT_SYSTEM_PROMPT.equalsIgnoreCase(trimmedDirective)) {
            return basePrompt
                    + "\nGROUNDING RULE: " + trimmedDirective
                    + " If the retrieved code context does not contain the answer, state clearly that it is not present in the indexed repository rather than guessing.\n";
        }

        return basePrompt
                + "\nUSER INSTRUCTION (prioritize this tone, framing, and focus): " + trimmedDirective
                + "\nGround claims in the provided code context when available, and cite file paths and line ranges.\n";
    }

    public String userPrompt(String codeContext, String question) {
        return """
                Code context:
                %s

                User question:
                %s
                """.formatted(codeContext, question);
    }
}
