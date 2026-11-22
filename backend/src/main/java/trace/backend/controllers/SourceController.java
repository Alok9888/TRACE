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
import trace.backend.entity.IndexStatus;
import trace.backend.entity.Repository;
import trace.backend.services.RepoService;
import trace.backend.services.ingestion.FileIngestionService;

/**
 * Multi-source file ingestion entry points supporting PDF, Jupyter Notebooks (.ipynb),
 * IaC/CI configs (.tf, Dockerfile, docker-compose, GitHub Actions YAML), and EPUB books.
 */
@RestController
@RequiredArgsConstructor
public class SourceController {

    private final FileIngestionService fileIngestionService;
    private final RepoService repoService;
    private final WorkspaceContext workspaceContext;

    @PostMapping(
            value = { "/api/sources/upload", "/api/sources/pdf", "/api/repos/pdf" },
            consumes = MediaType.MULTIPART_FORM_DATA_VALUE)
    public ResponseEntity<RepositoryResponse> uploadFile(@RequestParam("file") MultipartFile file) {
        UUID workspaceId = workspaceContext.getWorkspaceId();
        Repository source = fileIngestionService.ingest(workspaceId, file);
        HttpStatus status = source.getIndexStatus() == IndexStatus.READY
                ? HttpStatus.OK
                : HttpStatus.ACCEPTED;
        return ResponseEntity.status(status).body(repoService.toResponse(source));
    }
}
