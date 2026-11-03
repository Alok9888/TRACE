package devPilot.backend.repository;

import java.time.Instant;
import java.util.List;
import java.util.Optional;
import java.util.UUID;

import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Modifying;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;
import org.springframework.transaction.annotation.Transactional;

import devPilot.backend.dto.IndexStatusResponse;
import devPilot.backend.dto.RepositoryResponse;
import devPilot.backend.entity.Repository;

public interface RepositoryRepository extends JpaRepository<Repository, UUID> {
    List<Repository> findByUserIdOrderByFullNameAsc(UUID userId);

    Optional<Repository> findByIdAndUserId(UUID id, UUID userId);

    Optional<Repository> findByUserIdAndGithubRepoId(UUID userId, Long githubRepoId);

    Optional<Repository> findFirstByUserIdAndOwnerIgnoreCaseAndNameIgnoreCase(UUID userId, String owner, String name);

    @Query("""
            SELECT new devPilot.backend.dto.RepositoryResponse(
                r.id, r.githubRepoId, r.owner, r.name, r.fullName, r.isPrivate,
                r.defaultBranch, r.language, r.htmlUrl, r.description,
                r.indexStatus, r.indexedAt, r.chunkCount, r.filesTotal, r.filesProcessed, r.errorMessage
            )
            FROM Repository r
            WHERE r.userId = :userId
            ORDER BY r.fullName ASC
            """)
    List<RepositoryResponse> findResponsesByUserIdOrderByFullNameAsc(@Param("userId") UUID userId);

    @Query("""
            SELECT new devPilot.backend.dto.RepositoryResponse(
                r.id, r.githubRepoId, r.owner, r.name, r.fullName, r.isPrivate,
                r.defaultBranch, r.language, r.htmlUrl, r.description,
                r.indexStatus, r.indexedAt, r.chunkCount, r.filesTotal, r.filesProcessed, r.errorMessage
            )
            FROM Repository r
            WHERE r.id = :id AND r.userId = :userId
            """)
    Optional<RepositoryResponse> findResponseByIdAndUserId(@Param("id") UUID id, @Param("userId") UUID userId);

    @Query("""
            SELECT new devPilot.backend.dto.IndexStatusResponse(
                r.id, r.indexStatus, r.filesTotal, r.filesProcessed,
                r.chunkCount, r.chunksTotal, r.chunksProcessed,
                r.indexingStage, r.indexingDetail, r.indexedAt, r.errorMessage
            )
            FROM Repository r
            WHERE r.id = :id AND r.userId = :userId
            """)
    Optional<IndexStatusResponse> findStatusByIdAndUserId(@Param("id") UUID id, @Param("userId") UUID userId);

    @Query("""
            SELECT new devPilot.backend.dto.IndexStatusResponse(
                r.id, r.indexStatus, r.filesTotal, r.filesProcessed,
                r.chunkCount, r.chunksTotal, r.chunksProcessed,
                r.indexingStage, r.indexingDetail, r.indexedAt, r.errorMessage
            )
            FROM Repository r
            WHERE r.userId = :userId AND lower(r.owner) = lower(:owner) AND lower(r.name) = lower(:name)
            """)
    List<IndexStatusResponse> findStatusByUserIdAndOwnerAndName(
            @Param("userId") UUID userId, @Param("owner") String owner, @Param("name") String name);

    @Modifying
    @Transactional
    @Query("""
            UPDATE Repository r
            SET r.indexingStage = :stage,
                r.indexingDetail = :detail,
                r.filesProcessed = CASE WHEN :filesDone >= 0 THEN :filesDone ELSE r.filesProcessed END,
                r.filesTotal = CASE WHEN :filesTotal >= 0 THEN :filesTotal ELSE r.filesTotal END,
                r.chunksProcessed = CASE WHEN :chunksDone >= 0 THEN :chunksDone ELSE r.chunksProcessed END,
                r.chunksTotal = CASE WHEN :chunksTotal >= 0 THEN :chunksTotal ELSE r.chunksTotal END,
                r.updatedAt = :updatedAt
            WHERE r.id = :repoId
            """)
    int updateIndexingProgress(
            @Param("repoId") UUID repoId,
            @Param("stage") String stage,
            @Param("detail") String detail,
            @Param("filesDone") int filesDone,
            @Param("filesTotal") int filesTotal,
            @Param("chunksDone") int chunksDone,
            @Param("chunksTotal") int chunksTotal,
            @Param("updatedAt") Instant updatedAt);
}
