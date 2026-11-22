package trace.backend.entity;

import java.time.Instant;
import java.util.UUID;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.GeneratedValue;
import jakarta.persistence.GenerationType;
import jakarta.persistence.Id;
import jakarta.persistence.Index;
import jakarta.persistence.PrePersist;
import jakarta.persistence.Table;
import lombok.AllArgsConstructor;
import lombok.Builder;
import lombok.Getter;
import lombok.NoArgsConstructor;
import lombok.Setter;

/**
 * Stores one-way SHA-256 hashes of per-workspace MCP API keys.
 * Plaintext keys are never persisted in the database.
 */
@Entity
@Table(
    name = "mcp_api_keys",
    indexes = {
        @Index(name = "idx_mcp_api_keys_hash", columnList = "key_hash", unique = true),
        @Index(name = "idx_mcp_api_keys_workspace_revoked", columnList = "workspace_id, revoked")
    }
)
@Getter
@Setter
@NoArgsConstructor
@AllArgsConstructor
@Builder
public class McpApiKey {

    @Id
    @GeneratedValue(strategy = GenerationType.UUID)
    private UUID id;

    @Column(name = "workspace_id", nullable = false)
    private UUID workspaceId;

    @Column(name = "key_hash", nullable = false, unique = true, length = 64)
    private String keyHash;

    @Column(name = "key_prefix", nullable = false, length = 24)
    private String keyPrefix;

    @Column(name = "key_last4", nullable = false, length = 4)
    private String keyLast4;

    @Column(name = "label", length = 100)
    private String label;

    @Column(name = "revoked", nullable = false)
    @Builder.Default
    private boolean revoked = false;

    @Column(name = "created_at", nullable = false, updatable = false)
    private Instant createdAt;

    @Column(name = "last_used_at")
    private Instant lastUsedAt;

    @Column(name = "revoked_at")
    private Instant revokedAt;

    @PrePersist
    void onCreate() {
        if (createdAt == null) {
            createdAt = Instant.now();
        }
    }

    public String maskedPreview() {
        return keyPrefix + "••••••••••••" + keyLast4;
    }
}
