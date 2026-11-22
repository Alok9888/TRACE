package trace.backend.services.ai;

import java.util.UUID;

import trace.backend.entity.SourceType;

public record ChatStreamContext(
        UUID userId,
        UUID sessionId,
        UUID repositoryId,
        String repositoryName,
        String repositoryVersion,
        SourceType sourceType) {

    public ChatStreamContext(
            UUID userId,
            UUID sessionId,
            UUID repositoryId,
            String repositoryName,
            String repositoryVersion) {
        this(userId, sessionId, repositoryId, repositoryName, repositoryVersion, SourceType.GITHUB_REPO);
    }

    public SourceType effectiveSourceType() {
        return sourceType != null ? sourceType : SourceType.GITHUB_REPO;
    }
}
