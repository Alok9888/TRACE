package trace.backend;

import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.*;

import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;

import org.junit.jupiter.api.Test;

import trace.backend.dto.CitationDto;
import trace.backend.dto.McpKeyGeneratedResponse;
import trace.backend.dto.McpKeyStatusResponse;
import trace.backend.dto.RepositoryResponse;
import trace.backend.entity.IndexStatus;
import trace.backend.entity.McpApiKey;
import trace.backend.entity.SourceType;
import trace.backend.exceptions.NotFoundException;
import trace.backend.exceptions.UnauthorizedException;
import trace.backend.repository.McpApiKeyRepository;
import trace.backend.services.RepoService;
import trace.backend.services.ai.CodeContextRetriever;
import trace.backend.services.mcp.McpApiKeyService;
import trace.backend.services.mcp.McpServerService;

class McpSecurityAndProtocolTest {

    @Test
    void apiKeyStoresOnlySha256HashSupportsRegenerationRevocationAndRejectsInvalidKeys() {
        List<McpApiKey> store = new ArrayList<>();
        McpApiKeyRepository repo = mockInMemoryKeyRepo(store);
        McpApiKeyService keyService = new McpApiKeyService(repo);

        UUID workspaceA = UUID.randomUUID();
        UUID workspaceB = UUID.randomUUID();

        // Generate Key A
        McpKeyGeneratedResponse keyA = keyService.generateOrRegenerate(workspaceA, "Cursor");
        assertTrue(keyA.apiKey().startsWith(McpApiKeyService.KEY_PREFIX));
        assertTrue(keyA.apiKey().length() >= 48, "Key must have high entropy");

        // Stored entity must hold SHA-256 hash — NEVER the plaintext key
        McpApiKey storedA = store.get(0);
        assertNotEquals(keyA.apiKey(), storedA.getKeyHash());
        assertEquals(64, storedA.getKeyHash().length());
        assertEquals(McpApiKeyService.sha256Hex(keyA.apiKey()), storedA.getKeyHash());

        // Status endpoint exposes only masked preview, never plaintext
        McpKeyStatusResponse statusA = keyService.getStatus(workspaceA);
        assertTrue(statusA.hasActiveKey());
        assertFalse(statusA.maskedKey().contains(keyA.apiKey()));
        assertTrue(statusA.maskedKey().endsWith(keyA.keyLast4()));

        // Authenticate via Bearer & X-API-Key
        assertEquals(workspaceA, keyService.authenticateOrThrow("Bearer " + keyA.apiKey(), null));
        assertEquals(workspaceA, keyService.authenticateOrThrow(null, keyA.apiKey()));

        // Generate Key B for separate workspace — resolves strictly to workspaceB
        McpKeyGeneratedResponse keyB = keyService.generateOrRegenerate(workspaceB, "Claude");
        assertEquals(workspaceB, keyService.authenticateOrThrow("Bearer " + keyB.apiKey(), null));

        // Regenerating Key A immediately invalidates old Key A
        McpKeyGeneratedResponse keyA2 = keyService.generateOrRegenerate(workspaceA, "Cursor 2");
        assertNotEquals(keyA.apiKey(), keyA2.apiKey());
        assertThrows(UnauthorizedException.class,
                () -> keyService.authenticateOrThrow("Bearer " + keyA.apiKey(), null));
        assertEquals(workspaceA, keyService.authenticateOrThrow("Bearer " + keyA2.apiKey(), null));

        // Revoking Workspace A invalidates Key A2 while keeping Workspace B intact
        keyService.revokeAll(workspaceA);
        assertThrows(UnauthorizedException.class,
                () -> keyService.authenticateOrThrow("Bearer " + keyA2.apiKey(), null));
        assertFalse(keyService.getStatus(workspaceA).hasActiveKey());
        assertEquals(workspaceB, keyService.authenticateOrThrow("Bearer " + keyB.apiKey(), null));

        // Missing or garbage keys fail with 401 UnauthorizedException
        assertThrows(UnauthorizedException.class, () -> keyService.authenticateOrThrow(null, null));
        assertThrows(UnauthorizedException.class, () -> keyService.authenticateOrThrow("Bearer invalid_token", null));
        assertThrows(UnauthorizedException.class, () -> keyService.authenticateOrThrow("Bearer trc_live_fakefakefakefakefakefakefake", null));
    }

    @Test
    @SuppressWarnings("unchecked")
    void mcpProtocolEnforcesStrictTenantIsolationAcrossTools() {
        UUID workspaceA = UUID.randomUUID();
        UUID workspaceB = UUID.randomUUID();
        UUID repoAId = UUID.randomUUID();
        UUID pdfBId = UUID.randomUUID();

        RepositoryResponse repoA = new RepositoryResponse(
                repoAId, 101L, "alice", "core-api", "alice/core-api", false, "main", "Java",
                "https://github.com/alice/core-api", "Alice private workspace repo",
                IndexStatus.READY, Instant.now(), 42, 12, 12, null,
                SourceType.GITHUB_REPO, null, null, null);
        RepositoryResponse pdfB = new RepositoryResponse(
                pdfBId, -202L, "PDF", "secret-spec", "secret-spec.pdf", true, "document", "PDF",
                null, "Bob confidential PDF",
                IndexStatus.READY, Instant.now(), 18, 5, 5, null,
                SourceType.PDF, "secret-spec.pdf", 204800L, 5);

        RepoService repoService = mock(RepoService.class);
        when(repoService.listStored(workspaceA)).thenReturn(List.of(repoA));
        when(repoService.listStored(workspaceB)).thenReturn(List.of(pdfB));
        when(repoService.getResponse(repoAId, workspaceA)).thenReturn(repoA);
        when(repoService.getResponse(pdfBId, workspaceB)).thenReturn(pdfB);
        when(repoService.getResponse(pdfBId, workspaceA)).thenThrow(new NotFoundException("Repository not found"));
        when(repoService.getResponse(repoAId, workspaceB)).thenThrow(new NotFoundException("Repository not found"));

        CodeContextRetriever retriever = mock(CodeContextRetriever.class);
        when(retriever.searchForWorkspace(eq(workspaceA), eq(null), eq("auth filter"), eq(5), eq(0.30)))
                .thenReturn(List.of(new CodeContextRetriever.SearchHit(
                        "// File: SecurityConfig.java\npublic class SecurityConfig {}",
                        0.89,
                        repoAId.toString(),
                        new CitationDto("SecurityConfig.java", 10, 22, "java", "GITHUB_REPO", null, null, 0))));
        when(retriever.fetchSourceChunks(eq(workspaceB), eq(pdfBId), eq(null), eq(2), eq(0), eq(6)))
                .thenReturn(List.of(new CodeContextRetriever.SearchHit(
                        "[Document: secret-spec.pdf | Page 2]\nConfidential architecture notes.",
                        1.0,
                        pdfBId.toString(),
                        new CitationDto("secret-spec.pdf", null, null, "pdf", "PDF", 2, "Architecture", 1))));

        McpServerService server = new McpServerService(repoService, retriever);

        // 1. initialize
        Map<String, Object> initResp = server.handleJsonRpc(workspaceA, Map.of(
                "jsonrpc", "2.0", "id", 1, "method", "initialize",
                "params", Map.of("protocolVersion", "2025-03-26")));
        Map<String, Object> initResult = (Map<String, Object>) initResp.get("result");
        assertEquals("2025-03-26", initResult.get("protocolVersion"));

        // 2. tools/list returns all 4 tools
        Map<String, Object> listToolsResp = server.handleJsonRpc(workspaceA, Map.of(
                "jsonrpc", "2.0", "id", 2, "method", "tools/list"));
        List<Map<String, Object>> tools = (List<Map<String, Object>>) ((Map<String, Object>) listToolsResp.get("result")).get("tools");
        assertEquals(4, tools.size());

        // 3. Workspace A calls list_sources -> sees ONLY Alice's repo, NEVER Bob's PDF
        Map<String, Object> listA = server.handleJsonRpc(workspaceA, Map.of(
                "jsonrpc", "2.0", "id", 3, "method", "tools/call",
                "params", Map.of("name", "list_sources", "arguments", Map.of())));
        Map<String, Object> listAResult = (Map<String, Object>) listA.get("result");
        assertEquals(false, listAResult.get("isError"));
        String listAText = (String) ((List<Map<String, Object>>) listAResult.get("content")).get(0).get("text");
        assertTrue(listAText.contains("alice/core-api"));
        assertFalse(listAText.contains("secret-spec.pdf"), "Workspace A must never see Workspace B's sources");

        // 4. Workspace A attempts to inspect or search Workspace B's sourceId -> rejected!
        Map<String, Object> crossRead = server.handleJsonRpc(workspaceA, Map.of(
                "jsonrpc", "2.0", "id", 4, "method", "tools/call",
                "params", Map.of("name", "get_source_details", "arguments", Map.of("sourceId", pdfBId.toString()))));
        assertEquals(true, ((Map<String, Object>) crossRead.get("result")).get("isError"));

        Map<String, Object> crossSearch = server.handleJsonRpc(workspaceA, Map.of(
                "jsonrpc", "2.0", "id", 5, "method", "tools/call",
                "params", Map.of("name", "search_knowledge", "arguments", Map.of(
                        "query", "confidential", "sourceId", pdfBId.toString()))));
        assertEquals(true, ((Map<String, Object>) crossSearch.get("result")).get("isError"));
        verify(retriever, never()).searchForWorkspace(eq(workspaceA), eq(pdfBId), any(), anyInt(), anyDouble());

        // 5. Workspace A calls search_knowledge -> receives formatted citations
        Map<String, Object> searchA = server.handleJsonRpc(workspaceA, Map.of(
                "jsonrpc", "2.0", "id", 6, "method", "tools/call",
                "params", Map.of("name", "search_knowledge", "arguments", Map.of("query", "auth filter"))));
        Map<String, Object> searchAResult = (Map<String, Object>) searchA.get("result");
        assertEquals(false, searchAResult.get("isError"));
        String searchAText = (String) ((List<Map<String, Object>>) searchAResult.get("content")).get(0).get("text");
        assertTrue(searchAText.contains("SecurityConfig.java:10-22"));

        // 6. Workspace B calls get_source_excerpts on its own PDF -> gets Page 2 citation
        Map<String, Object> excerptsB = server.handleJsonRpc(workspaceB, Map.of(
                "jsonrpc", "2.0", "id", 7, "method", "tools/call",
                "params", Map.of("name", "get_source_excerpts", "arguments", Map.of(
                        "sourceId", pdfBId.toString(), "unitNumber", 2))));
        Map<String, Object> excerptsBResult = (Map<String, Object>) excerptsB.get("result");
        assertEquals(false, excerptsBResult.get("isError"));
        String excerptsBText = (String) ((List<Map<String, Object>>) excerptsBResult.get("content")).get(0).get("text");
        assertTrue(excerptsBText.contains("secret-spec.pdf · Page 2"));
    }

    private static McpApiKeyRepository mockInMemoryKeyRepo(List<McpApiKey> store) {
        McpApiKeyRepository repo = mock(McpApiKeyRepository.class);
        when(repo.save(any(McpApiKey.class))).thenAnswer(inv -> {
            McpApiKey k = inv.getArgument(0);
            if (k.getId() == null) k.setId(UUID.randomUUID());
            store.removeIf(existing -> existing.getId().equals(k.getId()));
            store.add(k);
            return k;
        });
        when(repo.saveAll(any())).thenAnswer(inv -> inv.getArgument(0));
        when(repo.findByWorkspaceIdAndRevokedFalse(any(UUID.class))).thenAnswer(inv -> {
            UUID ws = inv.getArgument(0);
            return store.stream().filter(k -> ws.equals(k.getWorkspaceId()) && !k.isRevoked()).toList();
        });
        when(repo.findFirstByWorkspaceIdAndRevokedFalseOrderByCreatedAtDesc(any(UUID.class))).thenAnswer(inv -> {
            UUID ws = inv.getArgument(0);
            return store.stream()
                    .filter(k -> ws.equals(k.getWorkspaceId()) && !k.isRevoked())
                    .reduce((first, second) -> second);
        });
        when(repo.findByKeyHashAndRevokedFalse(any(String.class))).thenAnswer(inv -> {
            String hash = inv.getArgument(0);
            return store.stream().filter(k -> hash.equals(k.getKeyHash()) && !k.isRevoked()).findFirst();
        });
        return repo;
    }
}
