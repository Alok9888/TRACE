package trace.backend.controllers;

import java.util.Map;

import jakarta.servlet.http.HttpServletResponse;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import lombok.RequiredArgsConstructor;
import trace.backend.config.WorkspaceContext;
import trace.backend.dto.McpKeyGeneratedResponse;
import trace.backend.dto.McpKeyStatusResponse;
import trace.backend.services.mcp.McpApiKeyService;

/**
 * Workspace-scoped management endpoints for generating, inspecting (masked), and revoking MCP API keys.
 */
@RestController
@RequestMapping("/api/mcp/keys")
@RequiredArgsConstructor
public class McpKeyController {

    private final McpApiKeyService apiKeyService;
    private final WorkspaceContext workspaceContext;

    @GetMapping
    public McpKeyStatusResponse status(HttpServletResponse response) {
        response.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");
        return apiKeyService.getStatus(workspaceContext.getWorkspaceId());
    }

    @PostMapping
    public ResponseEntity<McpKeyGeneratedResponse> generate(
            @RequestBody(required = false) Map<String, Object> body,
            HttpServletResponse response) {
        response.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");
        String label = body != null && body.get("label") instanceof String s ? s : null;
        McpKeyGeneratedResponse generated = apiKeyService.generateOrRegenerate(
                workspaceContext.getWorkspaceId(), label);
        return ResponseEntity.status(HttpStatus.CREATED).body(generated);
    }

    @DeleteMapping
    public ResponseEntity<Void> revoke(HttpServletResponse response) {
        response.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");
        apiKeyService.revokeAll(workspaceContext.getWorkspaceId());
        return ResponseEntity.noContent().build();
    }
}
