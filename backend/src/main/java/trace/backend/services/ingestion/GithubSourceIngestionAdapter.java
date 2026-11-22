package trace.backend.services.ingestion;

import java.util.UUID;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.Executor;

import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.stereotype.Service;

import lombok.extern.slf4j.Slf4j;
import trace.backend.entity.Repository;
import trace.backend.entity.SourceType;
import trace.backend.services.RepoService;

/**
 * GitHub repository ingestion adapter implementing {@link SourceIngestionAdapter}.
 * Keeps GitHub metadata resolution, archive streaming, file filtering, and code chunking isolated
 * behind the multi-source ingestion contract.
 */
@Service
@Slf4j
public class GithubSourceIngestionAdapter
        implements SourceIngestionAdapter<GithubSourceIngestionAdapter.GithubIngestRequest> {

    public record GithubIngestRequest(String owner, String name, boolean force) {}

    private final RepoService repoService;
    private final Executor ioExecutor;

    public GithubSourceIngestionAdapter(
            RepoService repoService,
            @Qualifier("ioExecutor") Executor ioExecutor) {
        this.repoService = repoService;
        this.ioExecutor = ioExecutor;
    }

    @Override
    public SourceType supportedType() {
        return SourceType.GITHUB_REPO;
    }

    @Override
    public Repository ingest(UUID workspaceId, GithubIngestRequest request) {
        RepoService.AnalyzeDecision decision = repoService.prepareAnalyze(
                workspaceId, request.owner(), request.name(), request.force());
        Repository repo = decision.repository();
        if (decision.shouldStart()) {
            CompletableFuture.runAsync(() -> {
                try {
                    repoService.analyzeAndStartIndexing(
                            workspaceId, request.owner(), request.name(), repo.getId(), request.force());
                } catch (Exception e) {
                    log.error("Background GitHub ingestion failed for {}/{}: {}",
                            request.owner(), request.name(), e.getMessage(), e);
                }
            }, ioExecutor);
        }
        return repo;
    }
}
