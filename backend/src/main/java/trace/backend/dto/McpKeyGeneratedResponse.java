package trace.backend.dto;

import java.time.Instant;
import java.util.UUID;

/**
 * One-time response returned ONLY when a new MCP API key is generated.
 * The plaintext {@code apiKey} is never persisted and cannot be retrieved again.
 */
public record McpKeyGeneratedResponse(
        UUID id,
        String apiKey,
        String maskedKey,
        String keyPrefix,
        String keyLast4,
        String label,
        Instant createdAt,
        String mcpEndpointPath) {
}
