package trace.backend.controllers;

import java.util.Map;
import java.util.UUID;

import jakarta.servlet.http.HttpServletResponse;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import lombok.RequiredArgsConstructor;
import trace.backend.services.mcp.McpApiKeyService;
import trace.backend.services.mcp.McpServerService;

/**
 * Standards-compliant MCP Streamable HTTP (JSON-RPC 2.0) endpoint at {@code /api/mcp} (and alias {@code /mcp}).
 * Authenticates every call exclusively via {@code Authorization: Bearer <api_key>} or {@code X-API-Key},
 * resolving strict per-workspace tenant isolation and returning 401 Unauthorized on invalid/revoked keys.
 */
@RestController
@RequestMapping({ "/api/mcp", "/mcp" })
@RequiredArgsConstructor
public class McpController {

    private final McpApiKeyService apiKeyService;
    private final McpServerService mcpServerService;

    @PostMapping(
            consumes = MediaType.APPLICATION_JSON_VALUE,
            produces = MediaType.APPLICATION_JSON_VALUE)
    public ResponseEntity<?> handlePost(
            @RequestHeader(value = HttpHeaders.AUTHORIZATION, required = false) String authorization,
            @RequestHeader(value = "X-API-Key", required = false) String xApiKey,
            @RequestHeader(value = "Mcp-Session-Id", required = false) String sessionId,
            @RequestBody(required = false) Map<String, Object> payload,
            HttpServletResponse response) {
        response.setHeader("Cache-Control", "no-store");
        UUID workspaceId = apiKeyService.authenticateOrThrow(authorization, xApiKey);

        Map<String, Object> result = mcpServerService.handleJsonRpc(workspaceId, payload);
        if (result == null) {
            return ResponseEntity.accepted().build();
        }
        String effectiveSessionId = (sessionId != null && !sessionId.isBlank())
                ? sessionId
                : UUID.randomUUID().toString();
        return ResponseEntity.ok()
                .header("Mcp-Session-Id", effectiveSessionId)
                .contentType(MediaType.APPLICATION_JSON)
                .body(result);
    }

    @GetMapping(produces = MediaType.APPLICATION_JSON_VALUE)
    public ResponseEntity<Map<String, Object>> handleGet(
            @RequestHeader(value = HttpHeaders.AUTHORIZATION, required = false) String authorization,
            @RequestHeader(value = "X-API-Key", required = false) String xApiKey) {
        apiKeyService.authenticateOrThrow(authorization, xApiKey);
        return ResponseEntity.status(HttpStatus.METHOD_NOT_ALLOWED)
                .body(Map.of(
                        "server", McpServerService.SERVER_NAME,
                        "protocolVersion", McpServerService.PROTOCOL_VERSION,
                        "message", "Send JSON-RPC 2.0 requests via HTTP POST to this MCP endpoint."));
    }

    @DeleteMapping
    public ResponseEntity<Void> handleDelete(
            @RequestHeader(value = HttpHeaders.AUTHORIZATION, required = false) String authorization,
            @RequestHeader(value = "X-API-Key", required = false) String xApiKey) {
        apiKeyService.authenticateOrThrow(authorization, xApiKey);
        return ResponseEntity.noContent().build();
    }
}
