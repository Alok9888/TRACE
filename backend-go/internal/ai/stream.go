package ai

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/google/uuid"

	"trace/backend-go/internal/cache"
	"trace/backend-go/internal/config"
	"trace/backend-go/internal/embedding"
	"trace/backend-go/internal/model"
	"trace/backend-go/internal/store"
)

const (
	firstTokenTimeout = 6 * time.Second
	chatStreamTimeout = 60 * time.Second
	heartbeatInterval = 4 * time.Second
	embedTimeout      = 15 * time.Second
	cooldown429       = 5 * time.Minute
	cooldown503       = 60 * time.Second
	cooldownTimeout   = 60 * time.Second
	cooldown404       = 30 * time.Minute
)

type StreamContext struct {
	UserID            uuid.UUID
	SessionID         uuid.UUID
	RepositoryID      uuid.UUID
	RepositoryName    string
	RepositoryVersion string
	SourceType        model.SourceType
}

type cachedAnswer struct {
	answer       string
	citations    []model.Citation
	modelName    string
	provider     string
	usedFallback bool
}

type providerError struct {
	statusCode int
	message    string
	isTimeout  bool
}

func (e *providerError) Error() string { return e.message }

// ChatStreamer orchestrates the end-to-end SSE RAG pipeline with:
// - Verified session context LRU cache (0ms hit)
// - Parallel Neon session lookup + Cloudflare pre-embedding on cache miss
// - Q&A response LRU cache
// - Groq multi-model failover (6s first-token timeout + cooldown circuit breaker)
// - Google Gemini 2.5 Flash last-resort fallback (thinkingBudget=0)
// - Deferred async batched Postgres persistence after SSE completes
type ChatStreamer struct {
	cfg          config.Config
	chats        *store.ChatStore
	vectors      *store.VectorStore
	embedder     embedding.Embedder
	httpClient   *http.Client
	contextCache *cache.LRU[string, StreamContext]
	qaCache      *cache.LRU[string, cachedAnswer]

	cooldownMu sync.RWMutex
	cooldowns  map[string]time.Time
}

func NewChatStreamer(cfg config.Config, chats *store.ChatStore, vectors *store.VectorStore, embedder embedding.Embedder) *ChatStreamer {
	transport := &http.Transport{
		MaxIdleConns:        32,
		MaxIdleConnsPerHost: 16,
		IdleConnTimeout:     90 * time.Second,
		ForceAttemptHTTP2:   true,
	}
	return &ChatStreamer{
		cfg:          cfg,
		chats:        chats,
		vectors:      vectors,
		embedder:     embedder,
		httpClient:   &http.Client{Transport: transport},
		contextCache: cache.NewLRU[string, StreamContext](500, 10*time.Minute),
		qaCache:      cache.NewLRU[string, cachedAnswer](500, 10*time.Minute),
		cooldowns:    make(map[string]time.Time),
	}
}

func (s *ChatStreamer) WarmUpGroq(ctx context.Context) {
	reqCtx, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(reqCtx, http.MethodHead, "https://api.groq.com", nil)
	if err != nil {
		return
	}
	resp, err := s.httpClient.Do(req)
	if err == nil {
		_, _ = io.Copy(io.Discard, resp.Body)
		_ = resp.Body.Close()
	}
}

func (s *ChatStreamer) PutSessionContext(userID, sessionID uuid.UUID, ctx StreamContext) {
	s.contextCache.Put(userID.String()+":"+sessionID.String(), ctx)
}

func (s *ChatStreamer) InvalidateRepository(repoID uuid.UUID) {
	s.contextCache.DeleteIf(func(_ string, val StreamContext) bool {
		return val.RepositoryID == repoID
	})
}

// StreamReply writes SSE frames directly to w and cancels upstream LLM/embedding calls
// immediately if r.Context() disconnects.
func (s *ChatStreamer) StreamReply(w http.ResponseWriter, r *http.Request, userID, sessionID uuid.UUID, req model.ChatMessageRequest) {
	flusher, ok := w.(http.Flusher)
	if !ok {
		http.Error(w, "streaming unsupported", http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache, no-transform")
	w.Header().Set("X-Accel-Buffering", "no")
	w.WriteHeader(http.StatusOK)

	var sseMu sync.Mutex
	sendRaw := func(frame string) error {
		sseMu.Lock()
		defer sseMu.Unlock()
		if _, err := io.WriteString(w, frame); err != nil {
			return err
		}
		flusher.Flush()
		return nil
	}
	sendEvent := func(name string, payload any) error {
		var data string
		switch v := payload.(type) {
		case string:
			if name == "done" {
				data = v
			} else {
				b, _ := json.Marshal(v)
				data = string(b)
			}
		default:
			b, err := json.Marshal(v)
			if err != nil {
				return err
			}
			data = string(b)
		}
		return sendRaw(fmt.Sprintf("event: %s\ndata: %s\n\n", name, data))
	}
	sendErrorAndDone := func(payload map[string]any) {
		_ = sendEvent("error", payload)
		_ = sendEvent("done", "[DONE]")
	}

	// Open stream immediately before DB or embedding work
	_ = sendRaw(": connected\n\n")

	ctx := r.Context()
	question := strings.TrimSpace(req.Content)
	genCfg := ParseGenerationConfig(req)
	tier := ClassifyQuery(question)

	// Heartbeat goroutine stops once first token arrives or stream exits
	hbStop := make(chan struct{})
	var hbOnce sync.Once
	stopHeartbeat := func() { hbOnce.Do(func() { close(hbStop) }) }
	defer stopHeartbeat()

	go func() {
		ticker := time.NewTicker(heartbeatInterval)
		defer ticker.Stop()
		for {
			select {
			case <-hbStop:
				return
			case <-ctx.Done():
				return
			case <-ticker.C:
				_ = sendRaw(": keepalive\n\n")
			}
		}
	}()

	// Step 1: Resolve session + repo context (overlap with query pre-embedding on cache miss)
	type embedResult struct {
		vec []float32
		err error
	}
	var preEmbedCh chan embedResult

	streamCtx, cached := s.contextCache.Get(userID.String() + ":" + sessionID.String())
	if !cached {
		if tier != TierTrivial {
			preEmbedCh = make(chan embedResult, 1)
			go func() {
				eCtx, cancel := context.WithTimeout(ctx, embedTimeout)
				defer cancel()
				v, err := s.embedder.EmbedQuery(eCtx, question)
				preEmbedCh <- embedResult{vec: v, err: err}
			}()
		}

		summary, err := s.chats.FindSessionWithRepo(ctx, sessionID, userID)
		if err != nil {
			sendErrorAndDone(map[string]any{"type": "error", "message": "Chat session not found"})
			return
		}
		if summary.IndexStatus != model.StatusReady {
			sendErrorAndDone(map[string]any{"type": "error", "message": "Source is not ready for chat"})
			return
		}
		repoVer := "v0"
		if summary.TreeSHA != nil && *summary.TreeSHA != "" {
			repoVer = *summary.TreeSHA
		} else if summary.IndexedAt != nil {
			repoVer = summary.IndexedAt.Format(time.RFC3339Nano)
		}
		streamCtx = StreamContext{
			UserID:            userID,
			SessionID:         summary.SessionID,
			RepositoryID:      summary.RepositoryID,
			RepositoryName:    summary.RepositoryFullName,
			RepositoryVersion: repoVer,
			SourceType:        summary.SourceType,
		}
		s.PutSessionContext(userID, sessionID, streamCtx)
	}

	userMsgID := uuid.New()
	userCreatedAt := time.Now().UTC()
	userResp := model.ChatMessageResponse{
		ID:        userMsgID,
		Role:      model.RoleUser,
		Content:   question,
		Citations: []model.Citation{},
		CreatedAt: userCreatedAt,
	}

	// Step 2: Check Q&A LRU cache
	qaKey := fmt.Sprintf("%s:%s:%s:%s", streamCtx.RepositoryID, streamCtx.RepositoryVersion, genCfg.CacheKeySegment(), strings.ToLower(strings.Join(strings.Fields(question), " ")))
	if hit, ok := s.qaCache.Get(qaKey); ok {
		stopHeartbeat()
		asstID := uuid.New()
		asstAt := ensureAfter(userCreatedAt)
		_ = sendEvent("user_message", userResp)
		_ = sendEvent("token", hit.answer)
		_ = sendEvent("model", map[string]any{
			"model":    hit.modelName,
			"provider": hit.provider,
			"fallback": hit.usedFallback,
			"cached":   true,
		})
		_ = sendEvent("assistant_message", model.ChatMessageResponse{
			ID:        asstID,
			Role:      model.RoleAssistant,
			Content:   hit.answer,
			Citations: hit.citations,
			CreatedAt: asstAt,
		})
		_ = sendEvent("done", "[DONE]")
		s.persistMessagesAsync(sessionID, userMsgID, userCreatedAt, question, asstID, asstAt, hit.answer, hit.citations)
		return
	}

	_ = sendEvent("user_message", userResp)

	// Step 3: Retrieval (skipped for TRIVIAL tier)
	var contextText string
	citations := []model.Citation{}
	if tier != TierTrivial {
		topK := genCfg.TopK
		if !genCfg.CustomTopK && tier == TierSimple {
			topK = min(3, genCfg.TopK)
		}
		tierChars := MaxContextChars
		switch tier {
		case TierSimple:
			tierChars = 2200
		case TierStandard:
			tierChars = 3200
		}
		maxChars := tierChars
		if genCfg.CustomTopK {
			maxChars = min(10_000, max(tierChars, topK*950))
		}

		var qVec []float32
		if preEmbedCh != nil {
			res := <-preEmbedCh
			if res.err == nil {
				qVec = res.vec
			}
		}
		if len(qVec) == 0 {
			eCtx, cancel := context.WithTimeout(ctx, embedTimeout)
			v, err := s.embedder.EmbedQuery(eCtx, question)
			cancel()
			if err != nil {
				sendErrorAndDone(map[string]any{"type": "error", "message": "Embedding query failed: " + err.Error()})
				return
			}
			qVec = v
		}

		sCtx, cancel := context.WithTimeout(ctx, embedTimeout)
		repoID := streamCtx.RepositoryID
		hits, err := s.vectors.Search(sCtx, streamCtx.UserID, &repoID, qVec, topK, genCfg.SimilarityThreshold)
		cancel()
		if err != nil {
			slog.Warn("vector search failed", "repoId", repoID, "err", err)
			hits = nil
		}
		contextText, citations = AssembleContext(hits, maxChars)
	}

	// Step 4: Prompt assembly & token budget
	systemPrompt := BuildSystemPrompt(streamCtx.RepositoryName, streamCtx.SourceType, tier, genCfg.SystemPrompt)
	var userPrompt string
	if tier == TierTrivial {
		userPrompt = question
	} else if len(citations) == 0 {
		userPrompt = EmptyMatchPrompt(question, streamCtx.SourceType)
	} else {
		userPrompt = BuildUserPrompt(contextText, question, streamCtx.SourceType)
	}

	targetMaxTokens := s.resolveTargetMaxTokens(tier, genCfg)
	noRelevantContext := tier != TierTrivial && len(citations) == 0

	// Step 5: Model selection & streaming with failover
	models := s.selectModelsForTier(tier)
	var triedModels []string
	var fullReply strings.Builder
	anyTokenSent := false
	sawQuota := false
	successfulModel := ""
	successfulProvider := ""

	emitToken := func(tok string) error {
		if tok == "" {
			return nil
		}
		if !anyTokenSent {
			anyTokenSent = true
			stopHeartbeat()
			if noRelevantContext {
				notice := "No relevant indexed passages found, answering from general context.\n\n"
				fullReply.WriteString(notice)
				if err := sendEvent("token", notice); err != nil {
					return err
				}
			}
		}
		fullReply.WriteString(tok)
		return sendEvent("token", tok)
	}

	for _, modelName := range models {
		if s.isInCooldown(modelName) {
			continue
		}
		triedModels = append(triedModels, modelName)
		err := s.streamGroq(ctx, modelName, systemPrompt, userPrompt, genCfg.Temperature, targetMaxTokens, emitToken)
		if err == nil {
			s.clearCooldown(modelName)
			successfulModel = modelName
			successfulProvider = "Groq"
			break
		}
		if anyTokenSent || ctx.Err() != nil {
			s.persistUserOnlyAsync(sessionID, userMsgID, userCreatedAt, question)
			sendErrorAndDone(map[string]any{"type": "error", "message": err.Error()})
			return
		}
		var pe *providerError
		if errors.As(err, &pe) {
			if pe.statusCode == http.StatusUnauthorized {
				s.persistUserOnlyAsync(sessionID, userMsgID, userCreatedAt, question)
				sendErrorAndDone(map[string]any{
					"type":        "error",
					"code":        "GROQ_FATAL",
					"model":       modelName,
					"triedModels": triedModels,
					"message":     pe.message,
				})
				return
			}
			switch {
			case pe.isTimeout:
				s.putCooldown(modelName, cooldownTimeout)
			case pe.statusCode == http.StatusTooManyRequests:
				sawQuota = true
				s.putCooldown(modelName, cooldown429)
			case pe.statusCode == http.StatusServiceUnavailable:
				s.putCooldown(modelName, cooldown503)
			case pe.statusCode == http.StatusNotFound:
				s.putCooldown(modelName, cooldown404)
			default:
				goto geminiFallback
			}
		} else {
			goto geminiFallback
		}
	}

geminiFallback:
	if successfulModel == "" {
		geminiModel := s.cfg.GeminiChatModel
		if geminiModel == "" {
			geminiModel = "gemini-2.5-flash"
		}
		triedModels = append(triedModels, geminiModel)
		err := s.streamGemini(ctx, geminiModel, systemPrompt, userPrompt, genCfg.Temperature, targetMaxTokens, emitToken)
		if err != nil {
			s.persistUserOnlyAsync(sessionID, userMsgID, userCreatedAt, question)
			code := "AI_ERROR"
			var pe *providerError
			if sawQuota || (errors.As(err, &pe) && pe.statusCode == http.StatusTooManyRequests) {
				code = "QUOTA_EXCEEDED"
			} else if errors.As(err, &pe) && pe.statusCode == http.StatusServiceUnavailable {
				code = "MODEL_OVERLOADED"
			}
			sendErrorAndDone(map[string]any{
				"type":        "error",
				"code":        code,
				"model":       geminiModel,
				"triedModels": triedModels,
				"message":     "All Groq models and Gemini fallback failed: " + err.Error(),
			})
			return
		}
		successfulModel = geminiModel
		successfulProvider = "Gemini"
	}

	stopHeartbeat()
	replyText := fullReply.String()
	if replyText == "" {
		replyText = "I couldn't generate a reply. Please try again."
		_ = sendEvent("token", replyText)
	}

	usedFallback := successfulProvider != "Groq" || (len(models) > 0 && successfulModel != models[0])
	if anyTokenSent && replyText != "" {
		s.qaCache.Put(qaKey, cachedAnswer{
			answer:       replyText,
			citations:    citations,
			modelName:    successfulModel,
			provider:     successfulProvider,
			usedFallback: usedFallback,
		})
	}

	asstID := uuid.New()
	asstAt := ensureAfter(userCreatedAt)
	_ = sendEvent("model", map[string]any{
		"model":    successfulModel,
		"provider": successfulProvider,
		"fallback": usedFallback,
	})
	_ = sendEvent("assistant_message", model.ChatMessageResponse{
		ID:        asstID,
		Role:      model.RoleAssistant,
		Content:   replyText,
		Citations: citations,
		CreatedAt: asstAt,
	})
	_ = sendEvent("done", "[DONE]")

	s.persistMessagesAsync(sessionID, userMsgID, userCreatedAt, question, asstID, asstAt, replyText, citations)
}

func (s *ChatStreamer) streamGroq(
	parentCtx context.Context,
	modelName, systemPrompt, userPrompt string,
	temperature float64,
	maxTokens int,
	emit func(string) error,
) error {
	if s.cfg.GroqAPIKey == "" {
		return &providerError{statusCode: 500, message: "GROQ_API_KEY is not configured"}
	}

	reqBody := map[string]any{
		"model":                 modelName,
		"stream":                true,
		"temperature":           temperature,
		"max_completion_tokens": maxTokens,
		"messages": []map[string]string{
			{"role": "system", "content": systemPrompt},
			{"role": "user", "content": userPrompt},
		},
	}
	if strings.Contains(modelName, "gpt-oss") && s.cfg.GroqReasoningEffort != "" {
		reqBody["reasoning_effort"] = s.cfg.GroqReasoningEffort
	}

	payload, _ := json.Marshal(reqBody)
	reqCtx, cancel := context.WithTimeout(parentCtx, chatStreamTimeout)
	defer cancel()

	// Enforce 6s first-token timeout so stalled/queued models fail over rapidly
	gotFirst := false
	firstTimer := time.AfterFunc(firstTokenTimeout, func() {
		if !gotFirst {
			cancel()
		}
	})
	defer firstTimer.Stop()

	req, err := http.NewRequestWithContext(reqCtx, http.MethodPost, s.cfg.GroqBaseURL+"/chat/completions", bytes.NewReader(payload))
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+s.cfg.GroqAPIKey)
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "text/event-stream")

	resp, err := s.httpClient.Do(req)
	if err != nil {
		if !gotFirst && errors.Is(reqCtx.Err(), context.Canceled) && parentCtx.Err() == nil {
			return &providerError{isTimeout: true, message: "Groq first-token timeout after 6s"}
		}
		if errors.Is(reqCtx.Err(), context.DeadlineExceeded) {
			return &providerError{isTimeout: true, message: "Groq stream timed out"}
		}
		return err
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		errBody, _ := io.ReadAll(io.LimitReader(resp.Body, 1024))
		return &providerError{statusCode: resp.StatusCode, message: fmt.Sprintf("HTTP %d: %s", resp.StatusCode, string(errBody))}
	}

	scanner := bufio.NewScanner(resp.Body)
	scanner.Buffer(make([]byte, 64*1024), 512*1024)
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if !strings.HasPrefix(line, "data:") {
			continue
		}
		data := strings.TrimSpace(strings.TrimPrefix(line, "data:"))
		if data == "" || data == "[DONE]" {
			continue
		}
		var chunk struct {
			Choices []struct {
				Delta struct {
					Content string `json:"content"`
				} `json:"delta"`
			} `json:"choices"`
		}
		if err := json.Unmarshal([]byte(data), &chunk); err != nil || len(chunk.Choices) == 0 {
			continue
		}
		tok := chunk.Choices[0].Delta.Content
		if tok != "" {
			if !gotFirst {
				gotFirst = true
				firstTimer.Stop()
			}
			if err := emit(tok); err != nil {
				return err
			}
		}
	}
	if err := scanner.Err(); err != nil {
		if !gotFirst && errors.Is(reqCtx.Err(), context.Canceled) && parentCtx.Err() == nil {
			return &providerError{isTimeout: true, message: "Groq first-token timeout after 6s"}
		}
		return err
	}
	return nil
}

func (s *ChatStreamer) streamGemini(
	parentCtx context.Context,
	modelName, systemPrompt, userPrompt string,
	temperature float64,
	maxTokens int,
	emit func(string) error,
) error {
	if s.cfg.GeminiAPIKey == "" {
		return &providerError{statusCode: 500, message: "GOOGLE_GENAI_API_KEY is not configured"}
	}

	endpoint := fmt.Sprintf(
		"https://generativelanguage.googleapis.com/v1beta/models/%s:streamGenerateContent?alt=sse&key=%s",
		modelName, s.cfg.GeminiAPIKey,
	)
	reqBody := map[string]any{
		"systemInstruction": map[string]any{
			"parts": []map[string]string{{"text": systemPrompt}},
		},
		"contents": []map[string]any{
			{
				"role":  "user",
				"parts": []map[string]string{{"text": userPrompt}},
			},
		},
		"generationConfig": map[string]any{
			"temperature":     temperature,
			"maxOutputTokens": maxTokens,
			// Disable Gemini 2.5 Flash silent thinking so TTFT stays ~300-500ms
			"thinkingConfig": map[string]int{"thinkingBudget": 0},
		},
	}

	payload, _ := json.Marshal(reqBody)
	reqCtx, cancel := context.WithTimeout(parentCtx, chatStreamTimeout)
	defer cancel()

	req, err := http.NewRequestWithContext(reqCtx, http.MethodPost, endpoint, bytes.NewReader(payload))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "text/event-stream")

	resp, err := s.httpClient.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		errBody, _ := io.ReadAll(io.LimitReader(resp.Body, 1024))
		return &providerError{statusCode: resp.StatusCode, message: fmt.Sprintf("HTTP %d: %s", resp.StatusCode, string(errBody))}
	}

	scanner := bufio.NewScanner(resp.Body)
	scanner.Buffer(make([]byte, 64*1024), 512*1024)
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if !strings.HasPrefix(line, "data:") {
			continue
		}
		data := strings.TrimSpace(strings.TrimPrefix(line, "data:"))
		if data == "" {
			continue
		}
		var chunk struct {
			Candidates []struct {
				Content struct {
					Parts []struct {
						Text string `json:"text"`
					} `json:"parts"`
				} `json:"content"`
			} `json:"candidates"`
		}
		if err := json.Unmarshal([]byte(data), &chunk); err != nil {
			continue
		}
		for _, cand := range chunk.Candidates {
			for _, part := range cand.Content.Parts {
				if part.Text != "" {
					if err := emit(part.Text); err != nil {
						return err
					}
				}
			}
		}
	}
	return scanner.Err()
}

func (s *ChatStreamer) selectModelsForTier(tier QueryTier) []string {
	configured := s.cfg.GroqChatModels
	if len(configured) == 0 {
		configured = []string{"llama-3.3-70b-versatile", "llama-3.1-8b-instant", "openai/gpt-oss-20b"}
	}
	fast := strings.TrimSpace(s.cfg.GroqFastModel)
	if fast == "" {
		fast = "llama-3.1-8b-instant"
	}

	ordered := make([]string, 0, len(configured)+1)
	if tier == TierTrivial || tier == TierSimple {
		ordered = append(ordered, fast)
		for _, m := range configured {
			if m != fast {
				ordered = append(ordered, m)
			}
		}
		return ordered
	}

	for _, m := range configured {
		if !strings.Contains(m, "gpt-oss") {
			ordered = append(ordered, m)
		}
	}
	if len(ordered) == 0 {
		ordered = append(ordered, "llama-3.3-70b-versatile")
	}
	for _, m := range configured {
		found := false
		for _, existing := range ordered {
			if existing == m {
				found = true
				break
			}
		}
		if !found {
			ordered = append(ordered, m)
		}
	}
	return ordered
}

func (s *ChatStreamer) resolveTargetMaxTokens(tier QueryTier, cfg GenerationConfig) int {
	if tier == TierTrivial {
		return min(120, cfg.MaxTokens)
	}
	if cfg.CustomMaxTokens {
		return cfg.MaxTokens
	}
	baseMax := min(cfg.MaxTokens, s.cfg.GroqMaxTokens)
	switch tier {
	case TierSimple:
		return min(280, baseMax)
	case TierStandard:
		return min(600, baseMax)
	default:
		return baseMax
	}
}

func (s *ChatStreamer) isInCooldown(modelName string) bool {
	s.cooldownMu.RLock()
	until, ok := s.cooldowns[modelName]
	s.cooldownMu.RUnlock()
	if !ok {
		return false
	}
	if time.Now().Before(until) {
		return true
	}
	s.clearCooldown(modelName)
	return false
}

func (s *ChatStreamer) putCooldown(modelName string, d time.Duration) {
	s.cooldownMu.Lock()
	s.cooldowns[modelName] = time.Now().Add(d)
	s.cooldownMu.Unlock()
}

func (s *ChatStreamer) clearCooldown(modelName string) {
	s.cooldownMu.Lock()
	delete(s.cooldowns, modelName)
	s.cooldownMu.Unlock()
}

func (s *ChatStreamer) persistMessagesAsync(sessionID, userID uuid.UUID, userAt time.Time, question string, asstID uuid.UUID, asstAt time.Time, reply string, citations []model.Citation) {
	citBytes, _ := json.Marshal(citations)
	citStr := string(citBytes)
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		err := s.chats.InsertMessagesBatch(ctx, []store.PendingMessage{
			{ID: userID, SessionID: sessionID, Role: model.RoleUser, Content: question, Citations: nil, CreatedAt: userAt},
			{ID: asstID, SessionID: sessionID, Role: model.RoleAssistant, Content: reply, Citations: &citStr, CreatedAt: asstAt},
		})
		if err != nil {
			slog.Error("async chat_messages batch insert failed", "sessionId", sessionID, "err", err)
		}
	}()
}

func (s *ChatStreamer) persistUserOnlyAsync(sessionID, userID uuid.UUID, userAt time.Time, question string) {
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		_ = s.chats.InsertMessagesBatch(ctx, []store.PendingMessage{
			{ID: userID, SessionID: sessionID, Role: model.RoleUser, Content: question, CreatedAt: userAt},
		})
	}()
}

func ensureAfter(earlier time.Time) time.Time {
	now := time.Now().UTC()
	if now.After(earlier) {
		return now
	}
	return earlier.Add(time.Millisecond)
}
