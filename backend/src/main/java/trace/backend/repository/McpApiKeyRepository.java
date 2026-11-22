package trace.backend.repository;

import java.time.Instant;
import java.util.List;
import java.util.Optional;
import java.util.UUID;

import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Modifying;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;
import org.springframework.transaction.annotation.Transactional;

import trace.backend.entity.McpApiKey;

public interface McpApiKeyRepository extends JpaRepository<McpApiKey, UUID> {

    Optional<McpApiKey> findByKeyHashAndRevokedFalse(String keyHash);

    Optional<McpApiKey> findFirstByWorkspaceIdAndRevokedFalseOrderByCreatedAtDesc(UUID workspaceId);

    List<McpApiKey> findByWorkspaceIdAndRevokedFalse(UUID workspaceId);

    @Modifying
    @Transactional
    @Query("UPDATE McpApiKey k SET k.lastUsedAt = :usedAt WHERE k.id = :id")
    int touchLastUsed(@Param("id") UUID id, @Param("usedAt") Instant usedAt);
}
