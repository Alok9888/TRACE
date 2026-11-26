package github

import (
	"archive/zip"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"os"
	"strconv"
	"strings"
	"time"
)

const (
	apiBase         = "https://api.github.com"
	maxRetries      = 3
	maxRetryAfter   = 15 * time.Second
)

var retryBackoff = []time.Duration{2 * time.Second, 4 * time.Second, 8 * time.Second}

var ErrRepoNotFound = errors.New("Repo not found or private")

type RepoMetadata struct {
	ID            int64  `json:"id"`
	FullName      string `json:"full_name"`
	Private       bool   `json:"private"`
	DefaultBranch string `json:"default_branch"`
	Language      string `json:"language"`
	HTMLURL       string `json:"html_url"`
	Description   string `json:"description"`
}

type TreeEntry struct {
	Path string `json:"path"`
	Type string `json:"type"`
	SHA  string `json:"sha"`
	Size int64  `json:"size"`
}

type TreeResponse struct {
	Tree []TreeEntry `json:"tree"`
}

type Client struct {
	httpClient *http.Client
	token      string
	apiDelay   time.Duration
}

func NewClient(token string, apiDelayMs int) *Client {
	transport := &http.Transport{
		MaxIdleConns:        32,
		MaxIdleConnsPerHost: 16,
		IdleConnTimeout:     90 * time.Second,
		ForceAttemptHTTP2:   true,
	}
	return &Client{
		httpClient: &http.Client{Transport: transport},
		token:      strings.TrimSpace(token),
		apiDelay:   time.Duration(max(0, apiDelayMs)) * time.Millisecond,
	}
}

func (c *Client) PauseForRateLimit(ctx context.Context) error {
	if c.apiDelay <= 0 {
		return nil
	}
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-time.After(c.apiDelay):
		return nil
	}
}

func (c *Client) GetRepository(ctx context.Context, owner, repo string) (RepoMetadata, error) {
	endpoint := fmt.Sprintf("%s/repos/%s/%s", apiBase, url.PathEscape(owner), url.PathEscape(repo))
	var out RepoMetadata
	err := c.doJSONWithRetry(ctx, endpoint, 20*time.Second, &out)
	if out.DefaultBranch == "" {
		out.DefaultBranch = "main"
	}
	return out, err
}

func (c *Client) GetRepoTree(ctx context.Context, owner, repo, branch string) (TreeResponse, error) {
	endpoint := fmt.Sprintf("%s/repos/%s/%s/git/trees/%s?recursive=1",
		apiBase, url.PathEscape(owner), url.PathEscape(repo), url.PathEscape(branch))
	var out TreeResponse
	err := c.doJSONWithRetry(ctx, endpoint, 30*time.Second, &out)
	return out, err
}

// GetRawFileContent fetches public files over GitHub's HTTP/2 raw CDN (zero REST rate-limit cost),
// falling back automatically to the GitHub Contents API on non-200.
func (c *Client) GetRawFileContent(ctx context.Context, owner, repo, branch, path string) (string, error) {
	rawURL := fmt.Sprintf("https://raw.githubusercontent.com/%s/%s/%s/%s",
		url.PathEscape(owner), url.PathEscape(repo), url.PathEscape(branch), encodePathSegments(path))
	reqCtx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()

	req, err := http.NewRequestWithContext(reqCtx, http.MethodGet, rawURL, nil)
	if err == nil {
		req.Header.Set("User-Agent", "TRACE")
		resp, err := c.httpClient.Do(req)
		if err == nil {
			defer resp.Body.Close()
			if resp.StatusCode == http.StatusOK {
				body, readErr := io.ReadAll(resp.Body)
				if readErr == nil {
					return string(body), nil
				}
			}
		}
	}
	return c.GetFileContent(ctx, owner, repo, path)
}

func (c *Client) GetFileContent(ctx context.Context, owner, repo, path string) (string, error) {
	endpoint := fmt.Sprintf("%s/repos/%s/%s/contents/%s",
		apiBase, url.PathEscape(owner), url.PathEscape(repo), encodePathSegments(path))
	var payload struct {
		Encoding string `json:"encoding"`
		Content  string `json:"content"`
	}
	if err := c.doJSONWithRetry(ctx, endpoint, 20*time.Second, &payload); err != nil {
		return "", err
	}
	if payload.Content == "" {
		return "", nil
	}
	if payload.Encoding == "base64" {
		cleaned := strings.ReplaceAll(strings.ReplaceAll(payload.Content, "\n", ""), "\r", "")
		decoded, err := base64.StdEncoding.DecodeString(cleaned)
		if err != nil {
			return "", err
		}
		return string(decoded), nil
	}
	return payload.Content, nil
}

// StreamRepoZipball downloads the repository zipball in a single GitHub HTTP call to a temp file,
// then streams eligible entries one by one under maxFileBytes so peak heap stays tiny.
func (c *Client) StreamRepoZipball(
	ctx context.Context,
	owner, repo, branch string,
	maxFileBytes int64,
	isEligible func(path string, size int64) bool,
	onFile func(path, content string) error,
) (int, error) {
	endpoint := fmt.Sprintf("%s/repos/%s/%s/zipball/%s",
		apiBase, url.PathEscape(owner), url.PathEscape(repo), url.PathEscape(branch))

	var tempPath string
	defer func() {
		if tempPath != "" {
			_ = os.Remove(tempPath)
		}
	}()

	err := c.withRateLimitRetry(ctx, "zipball", func() (int, http.Header, error) {
		reqCtx, cancel := context.WithTimeout(ctx, 120*time.Second)
		defer cancel()

		req, err := c.newAPIRequest(reqCtx, endpoint)
		if err != nil {
			return 0, nil, err
		}
		resp, err := c.httpClient.Do(req)
		if err != nil {
			return 0, nil, err
		}
		defer resp.Body.Close()

		if resp.StatusCode == http.StatusNotFound {
			return resp.StatusCode, resp.Header, ErrRepoNotFound
		}
		if resp.StatusCode != http.StatusOK {
			return resp.StatusCode, resp.Header, fmt.Errorf("github zipball HTTP %d", resp.StatusCode)
		}

		tmp, err := os.CreateTemp("", "trace-zipball-*.zip")
		if err != nil {
			return 0, nil, err
		}
		tempPath = tmp.Name()
		_, copyErr := io.Copy(tmp, resp.Body)
		closeErr := tmp.Close()
		if copyErr != nil {
			return 0, nil, copyErr
		}
		return http.StatusOK, resp.Header, closeErr
	})
	if err != nil {
		return 0, err
	}

	zr, err := zip.OpenReader(tempPath)
	if err != nil {
		return 0, fmt.Errorf("open zipball: %w", err)
	}
	defer zr.Close()

	streamed := 0
	for _, f := range zr.File {
		if ctx.Err() != nil {
			return streamed, ctx.Err()
		}
		if f.FileInfo().IsDir() {
			continue
		}
		rel := stripTopLevelDir(f.Name)
		if rel == "" {
			continue
		}
		declaredSize := int64(f.UncompressedSize64)
		if !isEligible(rel, declaredSize) {
			continue
		}

		rc, err := f.Open()
		if err != nil {
			continue
		}
		data, err := io.ReadAll(io.LimitReader(rc, maxFileBytes+1))
		_ = rc.Close()
		if err != nil || int64(len(data)) > maxFileBytes || len(data) == 0 {
			continue
		}
		if err := onFile(rel, string(data)); err != nil {
			return streamed, err
		}
		streamed++
	}
	return streamed, nil
}

func (c *Client) doJSONWithRetry(ctx context.Context, endpoint string, timeout time.Duration, dest any) error {
	return c.withRateLimitRetry(ctx, endpoint, func() (int, http.Header, error) {
		reqCtx, cancel := context.WithTimeout(ctx, timeout)
		defer cancel()

		req, err := c.newAPIRequest(reqCtx, endpoint)
		if err != nil {
			return 0, nil, err
		}
		resp, err := c.httpClient.Do(req)
		if err != nil {
			return 0, nil, err
		}
		defer resp.Body.Close()

		if resp.StatusCode == http.StatusNotFound {
			return resp.StatusCode, resp.Header, ErrRepoNotFound
		}
		if resp.StatusCode != http.StatusOK {
			body, _ := io.ReadAll(io.LimitReader(resp.Body, 1024))
			return resp.StatusCode, resp.Header, fmt.Errorf("github HTTP %d: %s", resp.StatusCode, string(body))
		}
		return http.StatusOK, resp.Header, json.NewDecoder(resp.Body).Decode(dest)
	})
}

func (c *Client) withRateLimitRetry(ctx context.Context, op string, fn func() (int, http.Header, error)) error {
	var lastErr error
	for attempt := 0; attempt <= maxRetries; attempt++ {
		status, headers, err := fn()
		if err == nil {
			return nil
		}
		if errors.Is(err, ErrRepoNotFound) || ctx.Err() != nil {
			return err
		}
		lastErr = err
		retryable := status == http.StatusTooManyRequests || status >= 500 ||
			(status == http.StatusForbidden && isRateLimit(headers, err.Error()))
		if !retryable || attempt >= maxRetries {
			return err
		}

		delay := parseRetryAfter(headers)
		if delay <= 0 {
			delay = retryBackoff[attempt]
		} else if delay > maxRetryAfter {
			delay = maxRetryAfter
		}
		slog.Warn("github rate-limited/transient error, retrying", "op", op, "status", status, "delay", delay)
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(delay):
		}
	}
	return lastErr
}

func (c *Client) newAPIRequest(ctx context.Context, endpoint string) (*http.Request, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Accept", "application/vnd.github+json")
	req.Header.Set("X-GitHub-Api-Version", "2022-11-28")
	req.Header.Set("User-Agent", "TRACE")
	if c.token != "" {
		req.Header.Set("Authorization", "Bearer "+c.token)
	}
	return req, nil
}

func isRateLimit(h http.Header, errMsg string) bool {
	if h != nil {
		if h.Get("X-RateLimit-Remaining") == "0" || h.Get("Retry-After") != "" {
			return true
		}
	}
	lower := strings.ToLower(errMsg)
	return strings.Contains(lower, "rate limit") || strings.Contains(lower, "secondary rate")
}

func parseRetryAfter(h http.Header) time.Duration {
	if h == nil {
		return 0
	}
	if ra := strings.TrimSpace(h.Get("Retry-After")); ra != "" {
		if secs, err := strconv.ParseInt(ra, 10, 64); err == nil && secs > 0 {
			return time.Duration(secs) * time.Second
		}
	}
	if reset := strings.TrimSpace(h.Get("X-RateLimit-Reset")); reset != "" {
		if epoch, err := strconv.ParseInt(reset, 10, 64); err == nil {
			d := time.Until(time.Unix(epoch, 0))
			if d > 0 {
				return d
			}
		}
	}
	return 0
}

func stripTopLevelDir(entry string) string {
	idx := strings.IndexByte(entry, '/')
	if idx < 0 {
		return entry
	}
	return entry[idx+1:]
}

func encodePathSegments(path string) string {
	parts := strings.Split(path, "/")
	for i, p := range parts {
		parts[i] = url.PathEscape(p)
	}
	return strings.Join(parts, "/")
}
