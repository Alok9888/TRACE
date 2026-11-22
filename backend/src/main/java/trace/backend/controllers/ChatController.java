package trace.backend.controllers;

import java.util.List;
import java.util.UUID;
import jakarta.servlet.http.HttpServletResponse;

import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.servlet.mvc.method.annotation.SseEmitter;

import trace.backend.dto.ChatMessageRequest;
import trace.backend.dto.ChatMessageResponse;
import trace.backend.dto.ChatSessionResponse;
import trace.backend.dto.CreateChatSessionRequest;
import trace.backend.config.WorkspaceContext;
import trace.backend.exceptions.BadRequestException;
import trace.backend.services.ChatService;
import jakarta.validation.Valid;
import lombok.RequiredArgsConstructor;

@RestController
@RequestMapping("/api/chat")
@RequiredArgsConstructor
public class ChatController {

    private final ChatService chatService;
    private final WorkspaceContext workspaceContext;

    @PostMapping("/sessions")
    public ResponseEntity<ChatSessionResponse> createSession(
            @Valid @RequestBody CreateChatSessionRequest request) {
        return ResponseEntity.ok(chatService.createSession(workspaceContext.getWorkspaceId(), request));
    }

    @GetMapping("/sessions")
    public List<ChatSessionResponse> listSessions(@RequestParam UUID repositoryId) {
        return chatService.listSessions(workspaceContext.getWorkspaceId(), repositoryId);
    }

    @GetMapping("/sessions/{id}")
    public List<ChatMessageResponse> getMessages(@PathVariable UUID id) {
        return chatService.getMessages(workspaceContext.getWorkspaceId(), id);
    }

    @PostMapping(value = "/sessions/{id}/messages", produces = MediaType.TEXT_EVENT_STREAM_VALUE)
    public SseEmitter sendMessage(
            @PathVariable UUID id,
            @Valid @RequestBody ChatMessageRequest request,
            HttpServletResponse response) {
        return openStream(id, request, response);
    }

    /**
     * Fixed-path SSE streaming endpoint so browsers cache a single CORS OPTIONS preflight
     * across all chat sessions instead of repeating a preflight RTT for every new session UUID.
     */
    @PostMapping(value = "/messages/stream", produces = MediaType.TEXT_EVENT_STREAM_VALUE)
    public SseEmitter streamMessage(
            @Valid @RequestBody ChatMessageRequest request,
            HttpServletResponse response) {
        if (request.sessionId() == null) {
            throw new BadRequestException("sessionId is required");
        }
        return openStream(request.sessionId(), request, response);
    }

    private SseEmitter openStream(UUID sessionId, ChatMessageRequest request, HttpServletResponse response) {
        response.setHeader("Cache-Control", "no-cache, no-transform");
        response.setHeader("X-Accel-Buffering", "no");
        return chatService.streamReply(
                workspaceContext.getWorkspaceId(),
                sessionId,
                request.content(),
                request.toGenerationConfig());
    }
}
