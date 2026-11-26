# syntax=docker/dockerfile:1

# --- Stage 1: Static Go Builder ---
FROM golang:1.23-alpine AS builder
WORKDIR /src

# Cache Go module downloads before copying source
COPY go.mod go.sum ./
RUN go mod download

COPY . .
RUN CGO_ENABLED=0 GOOS=linux go build -trimpath -ldflags="-s -w" -o /app/server ./cmd/server

# --- Stage 2: Minimal Non-Root Runtime ---
# Uses Alpine + poppler-utils so PDFExtractor's zero-heap `pdftotext` fast-path is available
# alongside ca-certificates for outbound TLS (Neon, Cloudflare Workers AI, Groq, Gemini, GitHub).
FROM alpine:3.21
RUN apk add --no-cache ca-certificates poppler-utils tzdata \
    && addgroup -S app \
    && adduser -S -G app -H -s /sbin/nologin app

WORKDIR /app
COPY --from=builder /app/server /app/server

ENV PORT=8080
EXPOSE 8080

USER app:app

# Exec form guarantees SIGTERM reaches the Go server directly for graceful shutdown
ENTRYPOINT ["/app/server"]
