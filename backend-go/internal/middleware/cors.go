package middleware

import (
	"net/http"
	"strings"
)

// CORS mirrors backend/src/main/java/trace/backend/config/CorsConfig.java:
// allows configured origins + https://*.vercel.app, exposes Mcp-Session-Id,
// allows GET/POST/DELETE/OPTIONS with credentials and 3600s preflight cache.
func CORS(allowedOrigins []string) func(http.Handler) http.Handler {
	cleaned := make([]string, 0, len(allowedOrigins))
	for _, o := range allowedOrigins {
		if trimmed := strings.TrimSpace(o); trimmed != "" {
			cleaned = append(cleaned, strings.TrimRight(trimmed, "/"))
		}
	}

	isAllowed := func(origin string) bool {
		if origin == "" {
			return false
		}
		norm := strings.TrimRight(origin, "/")
		for _, allowed := range cleaned {
			if allowed == "*" || strings.EqualFold(norm, allowed) {
				return true
			}
			if strings.Contains(allowed, "*") && matchWildcard(allowed, norm) {
				return true
			}
		}
		// Match Vercel preview & production deployments
		return strings.HasPrefix(norm, "https://") && strings.HasSuffix(norm, ".vercel.app")
	}

	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			origin := r.Header.Get("Origin")
			if isAllowed(origin) {
				h := w.Header()
				h.Set("Access-Control-Allow-Origin", origin)
				h.Set("Vary", "Origin")
				h.Set("Access-Control-Allow-Credentials", "true")
				h.Set("Access-Control-Expose-Headers", "Mcp-Session-Id")
				h.Set("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS")
				reqHeaders := r.Header.Get("Access-Control-Request-Headers")
				if reqHeaders != "" {
					h.Set("Access-Control-Allow-Headers", reqHeaders)
				} else {
					h.Set("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Workspace-Id, X-API-Key, Mcp-Session-Id, Accept")
				}
				h.Set("Access-Control-Max-Age", "3600")
			}

			if r.Method == http.MethodOptions {
				w.WriteHeader(http.StatusNoContent)
				return
			}
			next.ServeHTTP(w, r)
		})
	}
}

func matchWildcard(pattern, value string) bool {
	parts := strings.Split(pattern, "*")
	if len(parts) != 2 {
		return false
	}
	return strings.HasPrefix(value, parts[0]) && strings.HasSuffix(value, parts[1])
}
