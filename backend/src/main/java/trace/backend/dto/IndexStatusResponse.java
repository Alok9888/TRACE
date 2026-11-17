package trace.backend.dto;

import java.time.Instant;
import java.util.UUID;

import trace.backend.entity.IndexStatus;

public record IndexStatusResponse(
        UUID repositoryId,
        IndexStatus indexStatus,
        int filesTotal,
        int filesProcessed,
        int chunkCount,
        int chunksTotal,
        int chunksProcessed,
        String indexingStage,
        String indexingDetail,
        Instant indexedAt,
        String errorMessage) {
}
