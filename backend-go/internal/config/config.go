package config

import (
	"bufio"
	"fmt"
	"net/url"
	"os"
	"strconv"
	"strings"
)

// Config holds all runtime settings loaded strictly from environment variables.
// No framework magic, no reflection — every field is explicit and readable.
type Config struct {
	Port               string
	DatabaseURL        string
	VectorTable        string
	CorsAllowedOrigins []string

	// Cloudflare Workers AI embeddings
	CloudflareAccountID string
	CloudflareAPIToken  string

	// Groq (primary) + Gemini (last-resort fallback) chat models
	GroqAPIKey          string
	GroqBaseURL         string
	GroqFastModel       string
	GroqChatModels      []string
	GroqReasoningEffort string
	GroqMaxTokens       int
	GeminiAPIKey        string
	GeminiChatModel     string

	// GitHub & indexing tuning
	GitHubToken       string
	GitHubAPIDelayMs  int
	MaxFileBytes      int64
	CodeChunkSize     int
	SemanticChunkSize int
	MaxUploadBytes    int64
	DBMaxConns        int32
	DBMinConns        int32
}

func Load() Config {
	// Load local .env if present (never overrides real OS/Render environment variables)
	loadDotEnv(".env")
	return Config{
		Port:                envOr("PORT", "8080"),
		DatabaseURL:         resolveDatabaseURL(),
		VectorTable:         sanitizeTableName(envOr("PGVECTOR_TABLE", "trace_vectors_cf_384")),
		CorsAllowedOrigins:  splitCSV(envOr("APP_CORS_ALLOWED_ORIGINS", "http://localhost:3000")),
		CloudflareAccountID: strings.TrimSpace(os.Getenv("CLOUDFLARE_ACCOUNT_ID")),
		CloudflareAPIToken:  strings.TrimSpace(os.Getenv("CLOUDFLARE_API_TOKEN")),
		GroqAPIKey:          strings.TrimSpace(os.Getenv("GROQ_API_KEY")),
		GroqBaseURL:         strings.TrimRight(envOr("GROQ_BASE_URL", "https://api.groq.com/openai/v1"), "/"),
		GroqFastModel:       envOr("GROQ_FAST_MODEL", "llama-3.1-8b-instant"),
		GroqChatModels:      splitCSV(envOr("GROQ_CHAT_MODELS", "llama-3.3-70b-versatile,llama-3.1-8b-instant,openai/gpt-oss-20b,openai/gpt-oss-120b")),
		GroqReasoningEffort: envOr("GROQ_REASONING_EFFORT", "low"),
		GroqMaxTokens:       envInt("GROQ_MAX_TOKENS", 1024),
		GeminiAPIKey:        strings.TrimSpace(os.Getenv("GOOGLE_GENAI_API_KEY")),
		GeminiChatModel:     envOr("GEMINI_CHAT_MODEL", "gemini-2.5-flash"),
		GitHubToken:         strings.TrimSpace(os.Getenv("GITHUB_TOKEN")),
		GitHubAPIDelayMs:    envInt("GITHUB_API_DELAY_MS", 50),
		MaxFileBytes:        envInt64("INDEXING_MAX_FILE_BYTES", 102400),
		CodeChunkSize:       envInt("INDEXING_CHUNK_SIZE", 1600),
		SemanticChunkSize:   envInt("INDEXING_SEMANTIC_CHUNK_SIZE", 1500),
		MaxUploadBytes:      20 * 1024 * 1024, // 20 MB
		DBMaxConns:          int32(envInt("DB_MAX_CONNS", 8)),
		DBMinConns:          int32(envInt("DB_MIN_CONNS", 2)),
	}
}

// resolveDatabaseURL accepts either standard DATABASE_URL or the existing Render Spring Boot
// SPRING_DATASOURCE_URL / USERNAME / PASSWORD variables so Render deploys work seamlessly.
func resolveDatabaseURL() string {
	if raw := strings.TrimSpace(os.Getenv("DATABASE_URL")); raw != "" {
		return strings.TrimPrefix(raw, "jdbc:")
	}
	jdbcURL := strings.TrimSpace(os.Getenv("SPRING_DATASOURCE_URL"))
	if jdbcURL == "" {
		return "postgres://postgres:postgres@localhost:5433/trace?sslmode=disable"
	}
	cleaned := strings.TrimPrefix(jdbcURL, "jdbc:")
	parsed, err := url.Parse(cleaned)
	if err != nil {
		return cleaned
	}
	user := strings.TrimSpace(os.Getenv("SPRING_DATASOURCE_USERNAME"))
	pass := os.Getenv("SPRING_DATASOURCE_PASSWORD")
	if user != "" && parsed.User == nil {
		parsed.User = url.UserPassword(user, pass)
	}
	return parsed.String()
}

// sanitizeTableName prevents SQL injection from misconfigured table names.
func sanitizeTableName(raw string) string {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return "trace_vectors_cf_384"
	}
	for _, r := range raw {
		if !((r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') || (r >= '0' && r <= '9') || r == '_') {
			panic(fmt.Sprintf("invalid PGVECTOR_TABLE identifier: %q", raw))
		}
	}
	return raw
}

func envOr(key, fallback string) string {
	if v := strings.TrimSpace(os.Getenv(key)); v != "" {
		return v
	}
	return fallback
}

func envInt(key string, fallback int) int {
	v := strings.TrimSpace(os.Getenv(key))
	if v == "" {
		return fallback
	}
	n, err := strconv.Atoi(v)
	if err != nil {
		return fallback
	}
	return n
}

func envInt64(key string, fallback int64) int64 {
	v := strings.TrimSpace(os.Getenv(key))
	if v == "" {
		return fallback
	}
	n, err := strconv.ParseInt(v, 10, 64)
	if err != nil {
		return fallback
	}
	return n
}

func splitCSV(raw string) []string {
	parts := strings.Split(raw, ",")
	out := make([]string, 0, len(parts))
	for _, p := range parts {
		if trimmed := strings.TrimSpace(p); trimmed != "" {
			out = append(out, trimmed)
		}
	}
	return out
}

func loadDotEnv(path string) {
	f, err := os.Open(path)
	if err != nil {
		return
	}
	defer f.Close()

	scanner := bufio.NewScanner(f)
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		line = strings.TrimPrefix(line, "export ")
		eq := strings.IndexByte(line, '=')
		if eq <= 0 {
			continue
		}
		key := strings.TrimSpace(line[:eq])
		val := strings.TrimSpace(line[eq+1:])
		if len(val) >= 2 && ((val[0] == '"' && val[len(val)-1] == '"') || (val[0] == '\'' && val[len(val)-1] == '\'')) {
			val = val[1 : len(val)-1]
		}
		if key != "" && os.Getenv(key) == "" {
			_ = os.Setenv(key, val)
		}
	}
}
