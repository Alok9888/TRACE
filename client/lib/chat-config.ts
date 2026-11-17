export type ChatConfig = {
  temperature: number;
  maxTokens: number;
  topK: number;
  similarityThreshold: number;
  systemPrompt: string;
};

export const CHAT_CONFIG_LIMITS = {
  temperature: { min: 0, max: 1, step: 0.05 },
  maxTokens: { min: 256, max: 4096, step: 64 },
  topK: { min: 1, max: 10, step: 1 },
  similarityThreshold: { min: 0, max: 1, step: 0.05 },
  systemPromptMaxLength: 1200,
} as const;

export const DEFAULT_CHAT_CONFIG: ChatConfig = {
  temperature: 0.2,
  maxTokens: 1024,
  topK: 5,
  similarityThreshold: 0.35,
  systemPrompt: "Answer from repo code only.",
};

const STORAGE_KEY = "trace.chat.config.v1";

function clamp(val: number, min: number, max: number): number {
  if (!Number.isFinite(val)) return min;
  return Math.min(max, Math.max(min, val));
}

export function sanitizeChatConfig(raw: Partial<ChatConfig> | null | undefined): ChatConfig {
  if (!raw) return DEFAULT_CHAT_CONFIG;
  const temperature =
    typeof raw.temperature === "number"
      ? Math.round(clamp(raw.temperature, CHAT_CONFIG_LIMITS.temperature.min, CHAT_CONFIG_LIMITS.temperature.max) * 100) / 100
      : DEFAULT_CHAT_CONFIG.temperature;
  const maxTokens =
    typeof raw.maxTokens === "number"
      ? Math.round(clamp(raw.maxTokens, CHAT_CONFIG_LIMITS.maxTokens.min, CHAT_CONFIG_LIMITS.maxTokens.max))
      : DEFAULT_CHAT_CONFIG.maxTokens;
  const topK =
    typeof raw.topK === "number"
      ? Math.round(clamp(raw.topK, CHAT_CONFIG_LIMITS.topK.min, CHAT_CONFIG_LIMITS.topK.max))
      : DEFAULT_CHAT_CONFIG.topK;
  const similarityThreshold =
    typeof raw.similarityThreshold === "number"
      ? Math.round(
          clamp(
            raw.similarityThreshold,
            CHAT_CONFIG_LIMITS.similarityThreshold.min,
            CHAT_CONFIG_LIMITS.similarityThreshold.max
          ) * 100
        ) / 100
      : DEFAULT_CHAT_CONFIG.similarityThreshold;
  const systemPrompt =
    typeof raw.systemPrompt === "string"
      ? raw.systemPrompt.slice(0, CHAT_CONFIG_LIMITS.systemPromptMaxLength)
      : DEFAULT_CHAT_CONFIG.systemPrompt;

  return {
    temperature,
    maxTokens,
    topK,
    similarityThreshold,
    systemPrompt,
  };
}

export function loadChatConfig(): ChatConfig {
  if (typeof window === "undefined") return DEFAULT_CHAT_CONFIG;
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    if (!stored) return DEFAULT_CHAT_CONFIG;
    return sanitizeChatConfig(JSON.parse(stored) as Partial<ChatConfig>);
  } catch {
    return DEFAULT_CHAT_CONFIG;
  }
}

export function saveChatConfig(config: ChatConfig): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(config));
  } catch {
    // Ignore storage quota or private-mode errors
  }
}

export function isDefaultChatConfig(config: ChatConfig): boolean {
  return (
    config.temperature === DEFAULT_CHAT_CONFIG.temperature &&
    config.maxTokens === DEFAULT_CHAT_CONFIG.maxTokens &&
    config.topK === DEFAULT_CHAT_CONFIG.topK &&
    config.similarityThreshold === DEFAULT_CHAT_CONFIG.similarityThreshold &&
    (config.systemPrompt.trim() || DEFAULT_CHAT_CONFIG.systemPrompt) ===
      DEFAULT_CHAT_CONFIG.systemPrompt
  );
}
