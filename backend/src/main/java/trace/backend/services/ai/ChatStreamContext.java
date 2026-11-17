package trace.backend.services.ai;

import java.util.UUID;

public record ChatStreamContext(
        UUID userId,
        UUID sessionId,
        UUID repositoryId,
        String repositoryName,
        String repositoryVersion) {
}
