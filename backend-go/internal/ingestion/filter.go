package ingestion

import (
	"path"
	"strings"
)

var skipDirParts = map[string]struct{}{
	"node_modules": {}, ".git": {}, "dist": {}, "build": {}, "target": {},
	".next": {}, "vendor": {}, "__pycache__": {}, ".idea": {}, ".vscode": {},
	"coverage": {}, "out": {},
}

var allowedExtensions = map[string]struct{}{
	"java": {}, "kt": {}, "kts": {}, "scala": {},
	"ts": {}, "tsx": {}, "js": {}, "jsx": {}, "mjs": {}, "cjs": {},
	"py": {}, "go": {}, "rs": {}, "rb": {}, "php": {},
	"c": {}, "h": {}, "cpp": {}, "hpp": {}, "cs": {},
	"swift": {}, "m": {}, "mm": {},
	"md": {}, "mdx": {}, "txt": {},
	"yml": {}, "yaml": {}, "json": {}, "toml": {}, "xml": {},
	"properties": {}, "gradle": {}, "sql": {},
	"sh": {}, "bash": {}, "zsh": {},
	"tf": {}, "dockerfile": {}, "makefile": {},
	"html": {}, "css": {}, "scss": {}, "sass": {},
	"vue": {}, "svelte": {},
}

var skipFilenames = map[string]struct{}{
	"package-lock.json":  {},
	"npm-shrinkwrap.json": {},
	"yarn.lock":          {},
	"pnpm-lock.yaml":     {},
	"composer.lock":      {},
	"cargo.lock":         {},
	"poetry.lock":        {},
}

// IsEligibleCodeFile enforces TRACE's repo filtering rules AND explicitly permits
// `.github/workflows/*.yml|.yaml` (fixing the Java dot-directory filter conflict).
func IsEligibleCodeFile(filePath string, sizeBytes, maxFileBytes int64) bool {
	if strings.TrimSpace(filePath) == "" || sizeBytes > maxFileBytes {
		return false
	}
	norm := strings.ReplaceAll(filePath, "\\", "/")
	lower := strings.ToLower(norm)
	base := path.Base(lower)

	// Explicitly permit GitHub Actions workflow configs inside .github/workflows/
	isGithubWorkflow := (strings.HasPrefix(lower, ".github/workflows/") || strings.Contains(lower, "/.github/workflows/")) &&
		(strings.HasSuffix(base, ".yml") || strings.HasSuffix(base, ".yaml"))

	if !isGithubWorkflow {
		for _, part := range strings.Split(lower, "/") {
			if _, skip := skipDirParts[part]; skip {
				return false
			}
			if strings.HasPrefix(part, ".") && len(part) > 1 {
				return false
			}
		}
	}

	if _, skip := skipFilenames[base]; skip {
		return false
	}
	if strings.HasPrefix(base, ".") || strings.HasSuffix(base, ".min.js") || strings.HasSuffix(base, ".min.css") {
		return false
	}
	if base == "dockerfile" || base == "makefile" || strings.HasPrefix(base, "dockerfile.") {
		return true
	}

	dot := strings.LastIndexByte(base, '.')
	if dot < 0 {
		return false
	}
	_, ok := allowedExtensions[base[dot+1:]]
	return ok
}

func DetectLanguage(filePath string) string {
	lower := strings.ToLower(strings.ReplaceAll(filePath, "\\", "/"))
	base := path.Base(lower)
	if base == "dockerfile" || strings.HasPrefix(base, "dockerfile.") {
		return "dockerfile"
	}
	if base == "makefile" {
		return "makefile"
	}
	dot := strings.LastIndexByte(base, '.')
	if dot < 0 {
		return "text"
	}
	return base[dot+1:]
}
