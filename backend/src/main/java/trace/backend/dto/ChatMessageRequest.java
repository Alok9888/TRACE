package trace.backend.dto;

import java.util.UUID;

import trace.backend.services.ai.ChatGenerationConfig;
import jakarta.validation.constraints.DecimalMax;
import jakarta.validation.constraints.DecimalMin;
import jakarta.validation.constraints.Max;
import jakarta.validation.constraints.Min;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Size;

public record ChatMessageRequest(
        UUID sessionId,
        @NotBlank String content,
        @DecimalMin("0.0") @DecimalMax("1.0") Double temperature,
        @Min(256) @Max(4096) Integer maxTokens,
        @Min(1) @Max(10) Integer topK,
        @DecimalMin("0.0") @DecimalMax("1.0") Double similarityThreshold,
        @Size(max = 1200) String systemPrompt) {

    public ChatMessageRequest(String content) {
        this(null, content, null, null, null, null, null);
    }

    public ChatMessageRequest(
            String content,
            Double temperature,
            Integer maxTokens,
            Integer topK,
            Double similarityThreshold,
            String systemPrompt) {
        this(null, content, temperature, maxTokens, topK, similarityThreshold, systemPrompt);
    }

    public ChatGenerationConfig toGenerationConfig() {
        return ChatGenerationConfig.from(temperature, maxTokens, topK, similarityThreshold, systemPrompt);
    }
}
