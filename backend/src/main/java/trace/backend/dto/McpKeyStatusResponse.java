package trace.backend.dto;

import java.time.Instant;
import java.util.UUID;

/**
 * Safe metadata representation of an active MCP API key (never exposes plaintext or hash).
 */
public record McpKeyStatusResponse(
        boolean hasActiveKey,
        UUID id,
        String maskedKey,
        String keyPrefix,
        String keyLast4,
        String label,
        Instant createdAt,
        Instant lastUsedAt,
        String mcpEndpointPath) {

    public static McpKeyStatusResponse empty() {
        return new McpKeyStatusResponse(false, null, null, null, null, null, null, null, "/api/mcp");
    }
}
