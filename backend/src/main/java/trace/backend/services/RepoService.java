package trace.backend.services;

import java.time.Instant;
import java.time.Duration;
import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.Locale;
import java.util.UUID;
import java.util.concurrent.CompletableFuture;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;

import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import trace.backend.dto.IndexStatusResponse;
import trace.backend.dto.RepositoryResponse;
import trace.backend.entity.IndexStatus;
import trace.backend.entity.Repository;
import trace.backend.exceptions.NotFoundException;
import trace.backend.repository.RepositoryRepository;
import trace.backend.services.github.GithubApiClient;
import trace.backend.services.indexing.IndexingService;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;

@Service
@RequiredArgsConstructor
@Slf4j
public class RepoService {
    public record AnalyzeDecision(Repository repository, boolean shouldStart) {}

    private final RepositoryRepository repositoryRepository;
    private final GithubApiClient gitHubApiClient;
    private final IndexingService indexingService;
    private final Set<String> analyzeTasks = ConcurrentHashMap.newKeySet();
    private final ConcurrentHashMap<String, Object> prepareLocks = new ConcurrentHashMap<>();

    @Transactional
    public Repository analyzePublicRepo(UUID userId, String owner, String name) {
        var remote = gitHubApiClient.getRepository(owner, name);
        Long githubRepoId = toLong(remote.get("id"));
        Repository repo = repositoryRepository.findByUserIdAndGithubRepoId(userId, githubRepoId)
                .orElseGet(Repository::new);
        repo.setUserId(userId);
        repo.setGithubRepoId(githubRepoId);
        repo.setOwner(owner);
        repo.setName(name);
        repo.setFullName(String.valueOf(remote.get("full_name")));
        repo.setPrivate(Boolean.TRUE.equals(remote.get("private")));
        repo.setDefaultBranch(remote.get("default_branch") != null
                ? String.valueOf(remote.get("default_branch")) : "main");
        repo.setLanguage(remote.get("language") != null ? String.valueOf(remote.get("language")) : null);
        repo.setHtmlUrl(remote.get("html_url") != null ? String.valueOf(remote.get("html_url")) : null);
        repo.setDescription(remote.get("description") != null ? String.valueOf(remote.get("description")) : null);
        repo.setUpdatedAt(Instant.now());
        return repositoryRepository.save(repo);
    }

    
    @Transactional(readOnly = true)
    public List<RepositoryResponse> listStored(UUID userId) {
        return repositoryRepository.findResponsesByUserIdOrderByFullNameAsc(userId);
    }

    @Transactional(readOnly = true)
    public RepositoryResponse getResponse(UUID repoId, UUID userId) {
        return repositoryRepository.findResponseByIdAndUserId(repoId, userId)
                .orElseThrow(() -> new NotFoundException("Repository not found"));
    }

    @Transactional(readOnly = true)
    public Repository requireOwned(UUID repoId, UUID userId) {
        return repositoryRepository.findByIdAndUserId(repoId, userId)
                .orElseThrow(() -> new NotFoundException("Repository not found"));
    }

    @Transactional(readOnly = true)
    public IndexStatusResponse status(UUID repoId, UUID userId) {
        return repositoryRepository.findStatusByIdAndUserId(repoId, userId)
                .orElseThrow(() -> new NotFoundException("Repository not found"));
    }

     public RepositoryResponse toResponse(Repository repo) {
        return new RepositoryResponse(
                repo.getId(),
                repo.getGithubRepoId(),
                repo.getOwner(),
                repo.getName(),
                repo.getFullName(),
                repo.isPrivate(),
                repo.getDefaultBranch(),
                repo.getLanguage(),
                repo.getHtmlUrl(),
                repo.getDescription(),
                repo.getIndexStatus(),
                repo.getIndexedAt(),
                repo.getChunkCount(),
                repo.getFilesTotal(),
                repo.getFilesProcessed(),
                repo.getErrorMessage(),
                repo.effectiveSourceType(),
                repo.getFileName(),
                repo.getFileSizeBytes(),
                repo.getPageCount());
    }

    private static Long toLong(Object value) {
        if (value instanceof Number number) {
            return number.longValue();
        }
        return Long.parseLong(String.valueOf(value));
    }

    @Transactional
    public AnalyzeDecision prepareAnalyze(UUID userId, String owner, String name, boolean force) {
        String lockKey = userId + ":" + owner.toLowerCase(Locale.ROOT) + "/" + name.toLowerCase(Locale.ROOT);
        Object repoLock = prepareLocks.computeIfAbsent(lockKey, k -> new Object());
        synchronized (repoLock) {
            Repository existing = repositoryRepository
                    .findFirstByUserIdAndOwnerIgnoreCaseAndNameIgnoreCase(userId, owner, name)
                    .orElse(null);
            if (existing != null) {
                if (existing.getIndexStatus() == IndexStatus.READY && !force) {
                    return new AnalyzeDecision(existing, false);
                }
                Instant recentCutoff = Instant.now().minus(Duration.ofMinutes(10));
                boolean recentlyUpdated = existing.getUpdatedAt() != null
                        && !existing.getUpdatedAt().isBefore(recentCutoff);
                boolean active = existing.getIndexStatus() == IndexStatus.INDEXING
                        && (recentlyUpdated || indexingService.isIndexingActive(existing.getId()));
                if (active) {
                    log.info("Analyze already active for {}/{}, returning existing repository", owner, name);
                    return new AnalyzeDecision(existing, false);
                }
                return new AnalyzeDecision(existing, true);
            }

            Repository repo = new Repository();
            repo.setUserId(userId);
            repo.setGithubRepoId(placeholderGithubId(owner, name));
            repo.setOwner(owner);
            repo.setName(name);
            repo.setFullName(owner + "/" + name);
            repo.setDefaultBranch("main");
            repo.setIndexStatus(IndexStatus.INDEXING);
            repo.setIndexingStage("creating");
            repo.setIndexingDetail("Creating repo row...");
            repo.setUpdatedAt(Instant.now());
            return new AnalyzeDecision(repositoryRepository.save(repo), true);
        }
    }

    private static long placeholderGithubId(String owner, String name) {
        UUID key = UUID.nameUUIDFromBytes(
                (owner.toLowerCase() + "/" + name.toLowerCase()).getBytes(StandardCharsets.UTF_8));
        return key.getMostSignificantBits() | Long.MIN_VALUE;
    }

    /**
     * Background task: fetch GitHub metadata, create repo, start indexing
     */
    public void analyzeAndStartIndexing(UUID userId, String owner, String name, UUID repoId, boolean force) {
        String taskKey = userId + ":" + owner.toLowerCase(Locale.ROOT) + "/" + name.toLowerCase(Locale.ROOT);
        if (!analyzeTasks.add(taskKey)) {
            log.info("Analyze already running for {}/{}, skipping duplicate", owner, name);
            return;
        }
        try {
            Repository current = repositoryRepository.findByIdAndUserId(repoId, userId).orElse(null);
            if (current == null) return;
            if (current.getIndexStatus() == IndexStatus.READY && !force) {
                log.info("Repository {}/{} is already ready, skipping analyze", owner, name);
                return;
            }
            Instant recentCutoff = Instant.now().minus(Duration.ofMinutes(10));
            boolean recentlyUpdated = current.getUpdatedAt() != null
                    && !current.getUpdatedAt().isBefore(recentCutoff);
            if (current.getIndexStatus() == IndexStatus.INDEXING
                    && !"creating".equals(current.getIndexingStage())
                    && (recentlyUpdated || indexingService.isIndexingActive(repoId))) {
                log.info("Repository {}/{} is already indexing, skipping analyze", owner, name);
                return;
            }

            var remote = gitHubApiClient.getRepository(owner, name);
            Long githubRepoId = toLong(remote.get("id"));

            Repository repo = repositoryRepository.findByUserIdAndGithubRepoId(userId, githubRepoId)
                    .orElseGet(() -> repositoryRepository
                            .findByUserIdAndGithubRepoId(userId, placeholderGithubId(owner, name))
                            .orElseGet(Repository::new));
            repo.setUserId(userId);
            repo.setGithubRepoId(githubRepoId);
            repo.setOwner(owner);
            repo.setName(name);
            repo.setFullName(String.valueOf(remote.get("full_name")));
            repo.setPrivate(Boolean.TRUE.equals(remote.get("private")));
            repo.setDefaultBranch(remote.get("default_branch") != null
                    ? String.valueOf(remote.get("default_branch")) : "main");
            repo.setLanguage(remote.get("language") != null ? String.valueOf(remote.get("language")) : null);
            repo.setHtmlUrl(remote.get("html_url") != null ? String.valueOf(remote.get("html_url")) : null);
            repo.setDescription(remote.get("description") != null ? String.valueOf(remote.get("description")) : null);
            repo.setUpdatedAt(Instant.now());
            if (force) {
                repo.setTreeSha(null);
                repo.setIndexedFilesJson(null);
            }
            repo.setIndexStatus(IndexStatus.INDEXING);
            repo.setIndexingStage("fetching");
            repo.setIndexingDetail("Fetching file list...");
            repo.setFilesTotal(0);
            repo.setFilesProcessed(0);
            repo.setChunkCount(0);
            repo.setChunksTotal(0);
            repo.setChunksProcessed(0);

            repo = repositoryRepository.save(repo);

            // If we matched an existing row by githubRepoId instead of the placeholder row, delete the orphan placeholder
            if (repoId != null && !repoId.equals(repo.getId())) {
                try {
                    repositoryRepository.deleteById(repoId);
                } catch (Exception cleanupErr) {
                    log.warn("Could not delete placeholder repo row {}: {}", repoId, cleanupErr.getMessage());
                }
            }

            // Repo row is already persisted with IndexStatus.INDEXING; trigger async indexing directly
            indexingService.indexAsync(repo.getId(), userId, force);
        } catch (Exception e) {
            log.error("Background analyze failed for {}/{}: {}", owner, name, e.getMessage(), e);
            if (repoId != null) {
                repositoryRepository.findByIdAndUserId(repoId, userId).ifPresent(failedRepo -> {
                    failedRepo.setIndexStatus(IndexStatus.FAILED);
                    failedRepo.setIndexingStage("failed");
                    failedRepo.setIndexingDetail("Failed to analyze repository");
                    failedRepo.setErrorMessage(e.getMessage());
                    failedRepo.setUpdatedAt(Instant.now());
                    repositoryRepository.save(failedRepo);
                });
            }
        } finally {
            analyzeTasks.remove(taskKey);
        }
    }

    @Transactional(readOnly = true)
    public IndexStatusResponse statusByOwnerName(UUID userId, String owner, String name) {
        List<IndexStatusResponse> matches = repositoryRepository
                .findStatusByUserIdAndOwnerAndName(userId, owner, name);
        if (matches.isEmpty()) {
            return new IndexStatusResponse(
                    null,
                    IndexStatus.INDEXING,
                    0, 0, 0, 0, 0,
                    "creating",
                    "Creating repo row...",
                    null,
                    null
            );
        }
        return matches.get(0);
    }
}
