package trace.backend.repository;

import java.time.Instant;
import java.util.List;
import java.util.Optional;
import java.util.UUID;

import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;

import trace.backend.entity.ChatSession;
import trace.backend.entity.IndexStatus;
import trace.backend.entity.SourceType;

public interface ChatSessionRepository extends JpaRepository<ChatSession, UUID> {
    List<ChatSession> findByUserIdAndRepositoryIdOrderByCreatedAtDesc(UUID userId, UUID repositoryId);

    Optional<ChatSession> findByIdAndUserId(UUID id, UUID userId);

    record SessionRepoSummary(
            UUID sessionId,
            UUID repositoryId,
            String repositoryFullName,
            IndexStatus indexStatus,
            String treeSha,
            Instant indexedAt,
            SourceType sourceType) {}

    @Query("""
            SELECT new trace.backend.repository.ChatSessionRepository$SessionRepoSummary(
                s.id, r.id, r.fullName, r.indexStatus, r.treeSha, r.indexedAt,
                COALESCE(r.sourceType, trace.backend.entity.SourceType.GITHUB_REPO)
            )
            FROM ChatSession s, Repository r
            WHERE s.id = :sessionId
              AND s.userId = :userId
              AND r.id = s.repositoryId
              AND r.userId = :userId
            """)
    Optional<SessionRepoSummary> findSessionWithRepo(@Param("sessionId") UUID sessionId, @Param("userId") UUID userId);
}
