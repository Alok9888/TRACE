package main

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"trace/backend-go/internal/ai"
	"trace/backend-go/internal/api"
	"trace/backend-go/internal/config"
	"trace/backend-go/internal/embedding"
	gh "trace/backend-go/internal/github"
	"trace/backend-go/internal/ingestion"
	"trace/backend-go/internal/mcp"
	"trace/backend-go/internal/store"
)

func main() {
	slog.SetDefault(slog.New(slog.NewTextHandler(os.Stdout, &slog.HandlerOptions{Level: slog.LevelInfo})))

	cfg := config.Load()
	rootCtx := context.Background()

	pool, err := store.Connect(rootCtx, cfg)
	if err != nil {
		slog.Error("failed to connect to postgres", "err", err)
		os.Exit(1)
	}
	defer pool.Close()

	// Explicit wiring — zero DI annotations or hidden magic
	repoStore := store.NewRepoStore(pool)
	chatStore := store.NewChatStore(pool)
	mcpKeyStore := store.NewMcpKeyStore(pool)
	vectorStore := store.NewVectorStore(pool, cfg.VectorTable)

	cfEmbedder := embedding.NewCloudflareClient(cfg.CloudflareAccountID, cfg.CloudflareAPIToken)
	ghClient := gh.NewClient(cfg.GitHubToken, cfg.GitHubAPIDelayMs)
	chatStreamer := ai.NewChatStreamer(cfg, chatStore, vectorStore, cfEmbedder)

	repoIndexer := ingestion.NewRepoIndexer(
		repoStore, vectorStore, cfEmbedder, ghClient,
		cfg.MaxFileBytes, cfg.CodeChunkSize, cfg.SemanticChunkSize,
		chatStreamer.InvalidateRepository,
	)
	fileIngestor := ingestion.NewFileIngestor(
		repoStore, vectorStore, cfEmbedder,
		cfg.MaxUploadBytes, cfg.SemanticChunkSize,
		chatStreamer.InvalidateRepository,
	)

	mcpAuth := mcp.NewAuthService(mcpKeyStore)
	mcpServer := mcp.NewServer(&mcp.PostgresSourceBackend{
		Repos:    repoStore,
		Vectors:  vectorStore,
		Embedder: cfEmbedder,
	})

	// Background schema/index verification & external TLS pool warmup
	go func() {
		bgCtx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		store.EnsureSchema(bgCtx, pool, cfg.VectorTable)
		cfEmbedder.WarmUp(bgCtx)
		chatStreamer.WarmUpGroq(bgCtx)
	}()

	router := api.NewRouter(api.Dependencies{
		Config:       cfg,
		Repos:        repoStore,
		Chats:        chatStore,
		RepoIndexer:  repoIndexer,
		FileIngestor: fileIngestor,
		Streamer:     chatStreamer,
		McpAuth:      mcpAuth,
		McpServer:    mcpServer,
	})

	srv := &http.Server{
		Addr:              ":" + cfg.Port,
		Handler:           router,
		ReadHeaderTimeout: 10 * time.Second,
		IdleTimeout:       120 * time.Second,
		// WriteTimeout intentionally 0 so long-lived SSE chat streams are governed by request context
	}

	go func() {
		slog.Info("TRACE Go backend listening", "port", cfg.Port, "vectorTable", cfg.VectorTable, "build", "utf8-safe-v2")
		if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			slog.Error("server listen error", "err", err)
			os.Exit(1)
		}
	}()

	sigCh := make(chan os.Signal, 1)
	signal.Notify(sigCh, syscall.SIGINT, syscall.SIGTERM)
	<-sigCh

	slog.Info("shutting down TRACE Go backend...")
	shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	_ = srv.Shutdown(shutdownCtx)
}
