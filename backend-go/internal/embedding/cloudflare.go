package embedding

import (
	"bytes"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"strings"
	"sync/atomic"
	"time"

	"golang.org/x/sync/errgroup"

	"trace/backend-go/internal/cache"
)

const (
	ModelName             = "@cf/baai/bge-small-en-v1.5"
	Dimensions            = 384
	BatchSize             = 64
	MaxConcurrentBatches  = 3
	CacheTTL              = 30 * time.Minute
	QueryCacheCapacity    = 1000
	ChunkCacheCapacity    = 3000
	QueryTimeout          = 8 * time.Second
	IndexTimeout          = 45 * time.Second
)

var (
	queryRetryBackoff = []time.Duration{400 * time.Millisecond, 1200 * time.Millisecond}
	indexRetryBackoff = []time.Duration{1500 * time.Millisecond, 3000 * time.Millisecond, 6000 * time.Millisecond}
)

// Embedder is the minimal interface used by retrieval and ingestion pipelines.
type Embedder interface {
	EmbedQuery(ctx context.Context, text string) ([]float32, error)
	EmbedBatch(ctx context.Context, texts []string) ([][]float32, error)
	Dimensions() int
}

// CloudflareClient calls Cloudflare Workers AI @cf/baai/bge-small-en-v1.5 over HTTP/2
// with separate LRU query & chunk caches and strict non-zero vector validation.
type CloudflareClient struct {
	endpoint   string
	authHeader string
	httpClient *http.Client
	queryCache *cache.LRU[string, []float32]
	chunkCache *cache.LRU[string, []float32]
	apiCalls   atomic.Int64
	cacheHits  atomic.Int64
	cacheMiss  atomic.Int64
}

type apiError struct {
	statusCode int
	body       string
}

func (e *apiError) Error() string {
	return fmt.Sprintf("cloudflare embedding HTTP %d: %s", e.statusCode, e.body)
}

func NewCloudflareClient(accountID, apiToken string) *CloudflareClient {
	transport := &http.Transport{
		MaxIdleConns:        16,
		MaxIdleConnsPerHost: 16,
		IdleConnTimeout:     90 * time.Second,
		ForceAttemptHTTP2:   true,
	}
	return &CloudflareClient{
		endpoint:   fmt.Sprintf("https://api.cloudflare.com/client/v4/accounts/%s/ai/run/%s", accountID, ModelName),
		authHeader: "Bearer " + apiToken,
		httpClient: &http.Client{Transport: transport},
		queryCache: cache.NewLRU[string, []float32](QueryCacheCapacity, CacheTTL),
		chunkCache: cache.NewLRU[string, []float32](ChunkCacheCapacity, CacheTTL),
	}
}

func (c *CloudflareClient) Dimensions() int { return Dimensions }

// WarmUp establishes DNS + TCP + TLS 1.3 inside the shared HTTP/2 connection pool on startup.
func (c *CloudflareClient) WarmUp(ctx context.Context) {
	reqCtx, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(reqCtx, http.MethodHead, "https://api.cloudflare.com", nil)
	if err != nil {
		return
	}
	resp, err := c.httpClient.Do(req)
	if err == nil {
		_, _ = io.Copy(io.Discard, resp.Body)
		_ = resp.Body.Close()
	}
}

func (c *CloudflareClient) EmbedQuery(ctx context.Context, text string) ([]float32, error) {
	norm := normalizeQuery(text)
	normKey := hashKey(norm)
	rawKey := hashKey(text)

	if vec, ok := c.queryCache.Get(normKey); ok {
		c.cacheHits.Add(1)
		return vec, nil
	}
	if vec, ok := c.chunkCache.Get(rawKey); ok {
		c.cacheHits.Add(1)
		return vec, nil
	}
	c.cacheMiss.Add(1)

	vecs, err := c.embedWithRetry(ctx, []string{text}, QueryTimeout, queryRetryBackoff)
	if err != nil {
		return nil, err
	}
	if len(vecs) == 0 || !isValidVector(vecs[0]) {
		return nil, errors.New("invalid or zero embedding vector returned for query")
	}
	c.queryCache.Put(normKey, vecs[0])
	return vecs[0], nil
}

func (c *CloudflareClient) EmbedBatch(ctx context.Context, texts []string) ([][]float32, error) {
	if len(texts) == 0 {
		return nil, nil
	}
	resolved := make([][]float32, len(texts))
	missIdx := make([]int, 0, len(texts))
	missTexts := make([]string, 0, len(texts))

	for i, text := range texts {
		if vec, ok := c.chunkCache.Get(hashKey(text)); ok {
			resolved[i] = vec
			c.cacheHits.Add(1)
			continue
		}
		if vec, ok := c.queryCache.Get(hashKey(normalizeQuery(text))); ok {
			resolved[i] = vec
			c.cacheHits.Add(1)
			continue
		}
		c.cacheMiss.Add(1)
		missIdx = append(missIdx, i)
		missTexts = append(missTexts, text)
	}

	if len(missTexts) == 0 {
		return resolved, nil
	}

	g, gctx := errgroup.WithContext(ctx)
	g.SetLimit(MaxConcurrentBatches)

	for start := 0; start < len(missTexts); start += BatchSize {
		s := start
		e := min(start+BatchSize, len(missTexts))
		g.Go(func() error {
			batch := missTexts[s:e]
			vecs, err := c.embedWithRetry(gctx, batch, IndexTimeout, indexRetryBackoff)
			if err != nil {
				return err
			}
			if len(vecs) != len(batch) {
				return fmt.Errorf("cloudflare embedding count mismatch: expected %d got %d", len(batch), len(vecs))
			}
			for j, v := range vecs {
				if !isValidVector(v) {
					return fmt.Errorf("invalid or zero embedding vector at index %d", s+j)
				}
				resolved[missIdx[s+j]] = v
				c.chunkCache.Put(hashKey(batch[j]), v)
			}
			return nil
		})
	}
	if err := g.Wait(); err != nil {
		return nil, err
	}
	return resolved, nil
}

func (c *CloudflareClient) embedWithRetry(ctx context.Context, texts []string, timeout time.Duration, backoff []time.Duration) ([][]float32, error) {
	var lastErr error
	for attempt := 0; attempt <= len(backoff); attempt++ {
		vecs, err := c.callAPI(ctx, texts, timeout)
		if err == nil {
			return vecs, nil
		}
		lastErr = err

		var ae *apiError
		if errors.As(err, &ae) && ae.statusCode >= 400 && ae.statusCode < 500 && ae.statusCode != http.StatusTooManyRequests {
			return nil, err // Non-retryable 4xx
		}
		if ctx.Err() != nil || attempt >= len(backoff) {
			return nil, err
		}

		delay := backoff[attempt]
		slog.Warn("cloudflare embedding transient failure, retrying", "attempt", attempt+1, "delay", delay, "err", err)
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-time.After(delay):
		}
	}
	return nil, lastErr
}

type cfRequest struct {
	Text []string `json:"text"`
}

type cfResponse struct {
	Result struct {
		Data [][]float32 `json:"data"`
	} `json:"result"`
	Success bool `json:"success"`
}

func (c *CloudflareClient) callAPI(ctx context.Context, texts []string, timeout time.Duration) ([][]float32, error) {
	if c.authHeader == "Bearer " || strings.Contains(c.endpoint, "/accounts//ai/") {
		return nil, errors.New("CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN must be configured")
	}
	c.apiCalls.Add(1)

	payload, err := json.Marshal(cfRequest{Text: texts})
	if err != nil {
		return nil, err
	}

	reqCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()

	req, err := http.NewRequestWithContext(reqCtx, http.MethodPost, c.endpoint, bytes.NewReader(payload))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", c.authHeader)
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept-Encoding", "gzip")

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	var reader io.Reader = resp.Body
	if strings.EqualFold(resp.Header.Get("Content-Encoding"), "gzip") {
		gz, err := gzip.NewReader(resp.Body)
		if err != nil {
			return nil, err
		}
		defer gz.Close()
		reader = gz
	}

	if resp.StatusCode != http.StatusOK {
		errBytes, _ := io.ReadAll(io.LimitReader(reader, 2048))
		return nil, &apiError{statusCode: resp.StatusCode, body: string(errBytes)}
	}

	var parsed cfResponse
	if err := json.NewDecoder(reader).Decode(&parsed); err != nil {
		return nil, fmt.Errorf("decode cloudflare embedding response: %w", err)
	}
	if len(parsed.Result.Data) == 0 {
		return nil, errors.New("cloudflare embedding returned empty data")
	}
	return parsed.Result.Data, nil
}

func isValidVector(v []float32) bool {
	if len(v) != Dimensions {
		return false
	}
	for _, x := range v {
		if x != 0 {
			return true
		}
	}
	return false
}

func normalizeQuery(text string) string {
	return strings.ToLower(strings.Join(strings.Fields(text), " "))
}

func hashKey(text string) string {
	sum := sha256.Sum256([]byte(text))
	return hex.EncodeToString(sum[:])
}
