package devPilot.backend.services.github;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.URI;
import java.net.URLEncoder;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.time.Instant;
import java.util.Base64;
import java.util.Locale;
import java.util.Map;
import java.util.function.BiConsumer;
import java.util.function.BiPredicate;
import java.util.function.Supplier;
import java.util.zip.ZipEntry;
import java.util.zip.ZipInputStream;

import org.springframework.beans.factory.annotation.Value;
import org.springframework.core.ParameterizedTypeReference;
import org.springframework.http.HttpHeaders;
import org.springframework.stereotype.Service;
import org.springframework.web.client.HttpClientErrorException;
import org.springframework.web.client.HttpServerErrorException;
import org.springframework.web.client.RestClient;

import devPilot.backend.exceptions.NotFoundException;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;

@Service
@RequiredArgsConstructor
@Slf4j
public class GithubApiClient {

    private static final String API_BASE = "https://api.github.com";
    private static final int MAX_RETRIES = 3;
    private static final long[] RETRY_BACKOFF_MS = {2000L, 4000L, 8000L};
    private static final long MAX_RETRY_AFTER_MS = 15_000L;

    private static final HttpClient HTTP_CLIENT = HttpClient.newBuilder()
            .version(HttpClient.Version.HTTP_2)
            .connectTimeout(Duration.ofSeconds(10))
            .followRedirects(HttpClient.Redirect.NORMAL)
            .build();

    private static final ParameterizedTypeReference<Map<String, Object>> MAP = new ParameterizedTypeReference<>() {
    };

    private final RestClient.Builder restClientBuilder;
    @Value("${github.token:}")
    private String githubToken;
    private volatile RestClient cachedClient;

    public Map<String, Object> getRepository(String owner, String repo) {
        return executeWithRateLimitRetry("getRepository " + owner + "/" + repo, () -> {
            try {
                return client().get().uri("/repos/{owner}/{repo}", owner, repo).retrieve().body(MAP);
            } catch (HttpClientErrorException.NotFound ex) {
                throw new NotFoundException("Repo not found or private");
            }
        });
    }

    public Map<String, Object> getRepoTree(String owner, String repo, String branch) {
        return executeWithRateLimitRetry("getRepoTree " + owner + "/" + repo, () -> {
            try {
                return client()
                    .get()
                    .uri("/repos/{owner}/{repo}/git/trees/{branch}?recursive=1", owner, repo, branch)
                    .retrieve()
                    .body(MAP);
            } catch (HttpClientErrorException.NotFound ex) {
                throw new NotFoundException("Repo not found or private");
            }
        });
    }

    public String getFileContent(String owner, String repo, String path) {
        return executeWithRateLimitRetry("getFileContent " + path, () -> {
            Map<String, Object> body = client()
                    .get()
                    .uri("/repos/{owner}/{repo}/contents/{path}", owner, repo, path)
                    .retrieve()
                    .body(MAP);
            if (body == null) {
                return null;
            }
            Object encoding = body.get("encoding");
            Object content = body.get("content");
            if (content == null) {
                return null;
            }
            if ("base64".equals(String.valueOf(encoding))) {
                return new String(Base64.getMimeDecoder().decode(String.valueOf(content)), StandardCharsets.UTF_8);
            }
            return String.valueOf(content);
        });
    }

    /**
     * Streams a repository's zipball in a single GitHub HTTP request, reading one eligible file at a time
     * with a strict byte ceiling so large repos never exhaust heap or GitHub API rate limits.
     *
     * @return number of eligible files streamed to {@code onFile}
     */
    public int streamRepoZipball(
            String owner,
            String repo,
            String branch,
            long maxFileBytes,
            BiPredicate<String, Long> eligibilityCheck,
            BiConsumer<String, String> onFile) {
        String encodedOwner = URLEncoder.encode(owner, StandardCharsets.UTF_8);
        String encodedRepo = URLEncoder.encode(repo, StandardCharsets.UTF_8);
        String encodedBranch = URLEncoder.encode(branch, StandardCharsets.UTF_8);
        String url = API_BASE + "/repos/" + encodedOwner + "/" + encodedRepo + "/zipball/" + encodedBranch;

        return executeWithRateLimitRetry("streamRepoZipball " + owner + "/" + repo, () -> {
            try {
                HttpRequest.Builder reqBuilder = HttpRequest.newBuilder()
                        .uri(URI.create(url))
                        .header("Accept", "application/vnd.github+json")
                        .header("X-GitHub-Api-Version", "2022-11-28")
                        .header("User-Agent", "DevPilot")
                        .timeout(Duration.ofSeconds(120))
                        .GET();
                if (githubToken != null && !githubToken.isBlank()) {
                    reqBuilder.header("Authorization", "Bearer " + githubToken);
                }

                HttpResponse<InputStream> response = HTTP_CLIENT.send(
                        reqBuilder.build(), HttpResponse.BodyHandlers.ofInputStream());

                int status = response.statusCode();
                if (status == 404) {
                    closeQuietly(response.body());
                    throw new NotFoundException("Repo or branch not found: " + owner + "/" + repo + "@" + branch);
                }
                if (status == 403 || status == 429 || status >= 500) {
                    long retryAfterMs = parseRetryAfterMs(response.headers());
                    closeQuietly(response.body());
                    throw new GitHubRetryableException(status, retryAfterMs,
                            "GitHub zipball HTTP " + status + " for " + owner + "/" + repo);
                }
                if (status != 200) {
                    closeQuietly(response.body());
                    throw new RuntimeException("GitHub zipball failed with HTTP " + status);
                }

                int filesStreamed = 0;
                byte[] buffer = new byte[8192];
                try (InputStream bodyStream = response.body();
                     ZipInputStream zis = new ZipInputStream(bodyStream, StandardCharsets.UTF_8)) {
                    ZipEntry entry;
                    while ((entry = zis.getNextEntry()) != null) {
                        if (entry.isDirectory()) {
                            zis.closeEntry();
                            continue;
                        }
                        String relativePath = stripTopLevelDir(entry.getName());
                        if (relativePath.isEmpty()) {
                            zis.closeEntry();
                            continue;
                        }
                        long declaredSize = Math.max(0L, entry.getSize());
                        if (!eligibilityCheck.test(relativePath, declaredSize)) {
                            zis.closeEntry();
                            continue;
                        }

                        ByteArrayOutputStream baos = new ByteArrayOutputStream(
                                declaredSize > 0 ? (int) Math.min(declaredSize, maxFileBytes) : 4096);
                        long totalRead = 0;
                        boolean oversized = false;
                        int n;
                        while ((n = zis.read(buffer)) != -1) {
                            totalRead += n;
                            if (totalRead > maxFileBytes) {
                                oversized = true;
                                break;
                            }
                            baos.write(buffer, 0, n);
                        }
                        zis.closeEntry();

                        if (oversized || totalRead == 0) {
                            continue;
                        }
                        String content = baos.toString(StandardCharsets.UTF_8);
                        onFile.accept(relativePath, content);
                        filesStreamed++;
                    }
                }
                return filesStreamed;
            } catch (NotFoundException | GitHubRetryableException e) {
                throw e;
            } catch (Exception e) {
                throw new RuntimeException("Failed streaming GitHub zipball for " + owner + "/" + repo + ": " + e.getMessage(), e);
            }
        });
    }

    private <T> T executeWithRateLimitRetry(String operation, Supplier<T> action) {
        RuntimeException lastError = null;
        for (int attempt = 0; attempt <= MAX_RETRIES; attempt++) {
            try {
                return action.get();
            } catch (NotFoundException e) {
                throw e;
            } catch (GitHubRetryableException e) {
                lastError = e;
                if (attempt >= MAX_RETRIES) {
                    throw e;
                }
                long delayMs = e.retryAfterMs > 0
                        ? Math.min(e.retryAfterMs, MAX_RETRY_AFTER_MS)
                        : RETRY_BACKOFF_MS[attempt];
                log.warn("[GITHUB] {} rate-limited/transient HTTP {} (attempt {}/{}), sleeping {}ms",
                        operation, e.statusCode, attempt + 1, MAX_RETRIES + 1, delayMs);
                sleepQuietly(delayMs);
            } catch (HttpClientErrorException e) {
                lastError = e;
                int status = e.getStatusCode().value();
                if ((status == 403 || status == 429) && attempt < MAX_RETRIES && isRateLimitResponse(e)) {
                    long delayMs = parseRetryAfterMs(e.getResponseHeaders());
                    if (delayMs <= 0) {
                        delayMs = RETRY_BACKOFF_MS[attempt];
                    } else {
                        delayMs = Math.min(delayMs, MAX_RETRY_AFTER_MS);
                    }
                    log.warn("[GITHUB] {} HTTP {} rate limit (attempt {}/{}), sleeping {}ms",
                            operation, status, attempt + 1, MAX_RETRIES + 1, delayMs);
                    sleepQuietly(delayMs);
                } else {
                    throw e;
                }
            } catch (HttpServerErrorException e) {
                lastError = e;
                if (attempt >= MAX_RETRIES) {
                    throw e;
                }
                long delayMs = RETRY_BACKOFF_MS[attempt];
                log.warn("[GITHUB] {} HTTP {} server error (attempt {}/{}), sleeping {}ms",
                        operation, e.getStatusCode().value(), attempt + 1, MAX_RETRIES + 1, delayMs);
                sleepQuietly(delayMs);
            }
        }
        throw lastError != null ? lastError : new RuntimeException("GitHub API failed: " + operation);
    }

    private static boolean isRateLimitResponse(HttpClientErrorException e) {
        if (e.getStatusCode().value() == 429) {
            return true;
        }
        HttpHeaders headers = e.getResponseHeaders();
        if (headers != null) {
            if ("0".equals(headers.getFirst("X-RateLimit-Remaining"))) {
                return true;
            }
            if (headers.getFirst("Retry-After") != null) {
                return true;
            }
        }
        String body = e.getResponseBodyAsString().toLowerCase(Locale.ROOT);
        return body.contains("rate limit") || body.contains("secondary rate");
    }

    private static long parseRetryAfterMs(HttpHeaders headers) {
        if (headers == null) return 0L;
        String retryAfter = headers.getFirst("Retry-After");
        if (retryAfter != null && !retryAfter.isBlank()) {
            try {
                return Long.parseLong(retryAfter.trim()) * 1000L;
            } catch (NumberFormatException ignored) {
            }
        }
        String resetEpoch = headers.getFirst("X-RateLimit-Reset");
        if (resetEpoch != null && !resetEpoch.isBlank()) {
            try {
                long resetSeconds = Long.parseLong(resetEpoch.trim());
                long waitMs = (resetSeconds - Instant.now().getEpochSecond()) * 1000L;
                return Math.max(0L, waitMs);
            } catch (NumberFormatException ignored) {
            }
        }
        return 0L;
    }

    private static long parseRetryAfterMs(java.net.http.HttpHeaders headers) {
        if (headers == null) return 0L;
        var retryAfter = headers.firstValue("Retry-After");
        if (retryAfter.isPresent()) {
            try {
                return Long.parseLong(retryAfter.get().trim()) * 1000L;
            } catch (NumberFormatException ignored) {
            }
        }
        var resetEpoch = headers.firstValue("X-RateLimit-Reset");
        if (resetEpoch.isPresent()) {
            try {
                long resetSeconds = Long.parseLong(resetEpoch.get().trim());
                long waitMs = (resetSeconds - Instant.now().getEpochSecond()) * 1000L;
                return Math.max(0L, waitMs);
            } catch (NumberFormatException ignored) {
            }
        }
        return 0L;
    }

    private static String stripTopLevelDir(String zipEntryName) {
        if (zipEntryName == null) return "";
        int slash = zipEntryName.indexOf('/');
        return slash >= 0 ? zipEntryName.substring(slash + 1) : zipEntryName;
    }

    private static void sleepQuietly(long delayMs) {
        try {
            Thread.sleep(delayMs);
        } catch (InterruptedException ie) {
            Thread.currentThread().interrupt();
            throw new IllegalStateException("Interrupted during GitHub rate-limit backoff", ie);
        }
    }

    private static void closeQuietly(InputStream stream) {
        if (stream != null) {
            try {
                stream.close();
            } catch (IOException ignored) {
            }
        }
    }

    private RestClient client() {
        RestClient client = cachedClient;
        if (client != null) {
            return client;
        }
        synchronized (this) {
            if (cachedClient == null) {
                RestClient.Builder builder = restClientBuilder.clone()
                        .baseUrl(API_BASE)
                        .defaultHeader(HttpHeaders.ACCEPT, "application/vnd.github+json")
                        .defaultHeader("X-GitHub-Api-Version", "2022-11-28")
                        .defaultHeader(HttpHeaders.USER_AGENT, "DevPilot");
                if (githubToken != null && !githubToken.isBlank()) {
                    builder.defaultHeader(HttpHeaders.AUTHORIZATION, "Bearer " + githubToken);
                }
                cachedClient = builder.build();
            }
            return cachedClient;
        }
    }

    private static final class GitHubRetryableException extends RuntimeException {
        final int statusCode;
        final long retryAfterMs;

        GitHubRetryableException(int statusCode, long retryAfterMs, String message) {
            super(message);
            this.statusCode = statusCode;
            this.retryAfterMs = retryAfterMs;
        }
    }
}
