package trace.backend.services.ai;

import java.util.List;

import trace.backend.dto.CitationDto;

public record RetrievedContext(
        List<CitationDto> citations,
        String contextText) {
}
