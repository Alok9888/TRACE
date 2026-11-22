package trace.backend.controllers;

import java.util.UUID;

import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.multipart.MultipartFile;

import lombok.RequiredArgsConstructor;
import trace.backend.config.WorkspaceContext;
import trace.backend.dto.RepositoryResponse;
import trace.backend.entity.Repository;
import trace.backend.services.RepoService;
import trace.backend.services.ingestion.PdfIngestionService;

/**
 * Multi-source ingestion entry points for non-GitHub knowledge sources (starting with PDF documents).
 */
@RestController
@RequiredArgsConstructor
public class SourceController {

    private final PdfIngestionService pdfIngestionService;
    private final RepoService repoService;
    private final WorkspaceContext workspaceContext;

    @PostMapping(
            value = { "/api/sources/pdf", "/api/repos/pdf" },
            consumes = MediaType.MULTIPART_FORM_DATA_VALUE)
    public ResponseEntity<RepositoryResponse> uploadPdf(@RequestParam("file") MultipartFile file) {
        UUID workspaceId = workspaceContext.getWorkspaceId();
        Repository source = pdfIngestionService.ingest(workspaceId, file);
        return ResponseEntity.status(HttpStatus.ACCEPTED).body(repoService.toResponse(source));
    }
}
