package trace.backend.services.mcp;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.time.Instant;
import java.util.Base64;
import java.util.HexFormat;
import java.util.List;
import java.util.Optional;
import java.util.UUID;

import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import trace.backend.dto.McpKeyGeneratedResponse;
import trace.backend.dto.McpKeyStatusResponse;
import trace.backend.entity.McpApiKey;
import trace.backend.exceptions.UnauthorizedException;
import trace.backend.repository.McpApiKeyRepository;

/**
 * Cryptographically secure MCP API key lifecycle and authentication service.
 * Generates 256-bit high-entropy keys with prefix {@code trc_live_}, stores only SHA-256 hashes,
 * enforces strict per-workspace tenant resolution, and supports instant revocation/regeneration.
 */
@Service
@RequiredArgsConstructor
@Slf4j
public class McpApiKeyService {

    public static final String KEY_PREFIX = "trc_live_";
    private static final int ENTROPY_BYTES = 32; // 256 bits
    private static final SecureRandom SECURE_RANDOM = new SecureRandom();
    private static final Base64.Encoder BASE64_URL_NO_PAD = Base64.getUrlEncoder().withoutPadding();

    private final McpApiKeyRepository apiKeyRepository;

    @Transactional(readOnly = true)
    public McpKeyStatusResponse getStatus(UUID workspaceId) {
        return apiKeyRepository.findFirstByWorkspaceIdAndRevokedFalseOrderByCreatedAtDesc(workspaceId)
                .map(key -> new McpKeyStatusResponse(
                        true,
                        key.getId(),
                        key.maskedPreview(),
                        key.getKeyPrefix(),
                        key.getKeyLast4(),
                        key.getLabel(),
                        key.getCreatedAt(),
                        key.getLastUsedAt(),
                        "/api/mcp"))
                .orElseGet(McpKeyStatusResponse::empty);
    }

    /**
     * Revokes any previously active key for this workspace and issues a fresh 256-bit key.
     * The plaintext key is returned once and never stored.
     */
    @Transactional
    public McpKeyGeneratedResponse generateOrRegenerate(UUID workspaceId, String label) {
        Instant now = Instant.now();
        List<McpApiKey> existing = apiKeyRepository.findByWorkspaceIdAndRevokedFalse(workspaceId);
        for (McpApiKey oldKey : existing) {
            oldKey.setRevoked(true);
            oldKey.setRevokedAt(now);
        }
        if (!existing.isEmpty()) {
            apiKeyRepository.saveAll(existing);
        }

        byte[] randomBytes = new byte[ENTROPY_BYTES];
        SECURE_RANDOM.nextBytes(randomBytes);
        String secretSegment = BASE64_URL_NO_PAD.encodeToString(randomBytes);
        String plaintextKey = KEY_PREFIX + secretSegment;

        String keyHash = sha256Hex(plaintextKey);
        String displayPrefix = plaintextKey.substring(0, Math.min(KEY_PREFIX.length() + 4, plaintextKey.length()));
        String last4 = plaintextKey.substring(plaintextKey.length() - 4);
        String cleanLabel = (label != null && !label.isBlank())
                ? label.trim().substring(0, Math.min(label.trim().length(), 100))
                : "Workspace MCP Key";

        McpApiKey entity = McpApiKey.builder()
                .workspaceId(workspaceId)
                .keyHash(keyHash)
                .keyPrefix(displayPrefix)
                .keyLast4(last4)
                .label(cleanLabel)
                .revoked(false)
                .createdAt(now)
                .build();
        entity = apiKeyRepository.save(entity);

        log.info("[MCP-KEY] generated keyId={} workspaceId={} prefix={}", entity.getId(), workspaceId, displayPrefix);

        return new McpKeyGeneratedResponse(
                entity.getId(),
                plaintextKey,
                entity.maskedPreview(),
                entity.getKeyPrefix(),
                entity.getKeyLast4(),
                entity.getLabel(),
                entity.getCreatedAt(),
                "/api/mcp");
    }

    @Transactional
    public void revokeAll(UUID workspaceId) {
        Instant now = Instant.now();
        List<McpApiKey> active = apiKeyRepository.findByWorkspaceIdAndRevokedFalse(workspaceId);
        if (active.isEmpty()) {
            return;
        }
        for (McpApiKey key : active) {
            key.setRevoked(true);
            key.setRevokedAt(now);
        }
        apiKeyRepository.saveAll(active);
        log.info("[MCP-KEY] revoked {} active key(s) for workspaceId={}", active.size(), workspaceId);
    }

    /**
     * Authenticates an incoming MCP request using {@code Authorization: Bearer <key>} or {@code X-API-Key: <key>}.
     * Never falls back to AnonymousWorkspace or X-Workspace-Id.
     *
     * @return the strictly scoped owner workspace UUID
     * @throws UnauthorizedException when missing, malformed, unknown, or revoked
     */
    public UUID authenticateOrThrow(String authorizationHeader, String xApiKeyHeader) {
        String rawKey = extractRawKey(authorizationHeader, xApiKeyHeader);
        if (rawKey == null || !rawKey.startsWith(KEY_PREFIX) || rawKey.length() < KEY_PREFIX.length() + 24) {
            throw new UnauthorizedException("Invalid or missing MCP API key");
        }

        String hash = sha256Hex(rawKey);
        Optional<McpApiKey> match = apiKeyRepository.findByKeyHashAndRevokedFalse(hash);
        McpApiKey key = match.orElseThrow(() -> new UnauthorizedException("Invalid or revoked MCP API key"));

        // Constant-time verification on hash equality (defense-in-depth)
        if (!MessageDigest.isEqual(
                hash.getBytes(StandardCharsets.UTF_8),
                key.getKeyHash().getBytes(StandardCharsets.UTF_8))) {
            throw new UnauthorizedException("Invalid or revoked MCP API key");
        }

        try {
            apiKeyRepository.touchLastUsed(key.getId(), Instant.now());
        } catch (Exception ignored) {
            // Never block an MCP call if last_used_at update hits transient contention
        }

        return key.getWorkspaceId();
    }

    static String extractRawKey(String authorizationHeader, String xApiKeyHeader) {
        if (authorizationHeader != null && !authorizationHeader.isBlank()) {
            String trimmed = authorizationHeader.trim();
            if (trimmed.regionMatches(true, 0, "Bearer ", 0, 7)) {
                String token = trimmed.substring(7).trim();
                if (!token.isEmpty()) {
                    return token;
                }
            }
        }
        if (xApiKeyHeader != null && !xApiKeyHeader.isBlank()) {
            return xApiKeyHeader.trim();
        }
        return null;
    }

    public static String sha256Hex(String plaintext) {
        try {
            MessageDigest digest = MessageDigest.getInstance("SHA-256");
            byte[] hashed = digest.digest(plaintext.getBytes(StandardCharsets.UTF_8));
            return HexFormat.of().formatHex(hashed);
        } catch (Exception e) {
            throw new IllegalStateException("SHA-256 digest unavailable", e);
        }
    }
}
