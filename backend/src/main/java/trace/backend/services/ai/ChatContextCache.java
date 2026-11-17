package trace.backend.services.ai;

import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.TimeUnit;

import org.springframework.stereotype.Component;

/**
 * Short-TTL bounded LRU cache for verified READY chat session + repository metadata.
 * Eliminates the pre-RAG Postgres round-trip on every chat message; invalidated on repo re-index.
 */
@Component
public class ChatContextCache {

    private static final int MAX_ENTRIES = 500;
    private static final long TTL_MS = TimeUnit.MINUTES.toMillis(10);

    private final Map<String, CachedEntry> cache = Collections.synchronizedMap(
            new LinkedHashMap<>(128, 0.75f, true) {
                @Override
                protected boolean removeEldestEntry(Map.Entry<String, CachedEntry> eldest) {
                    return size() > MAX_ENTRIES;
                }
            });

    public ChatStreamContext get(UUID userId, UUID sessionId) {
        String key = cacheKey(userId, sessionId);
        CachedEntry entry = cache.get(key);
        if (entry == null) {
            return null;
        }
        if (System.currentTimeMillis() - entry.cachedAtMs < TTL_MS) {
            return entry.context;
        }
        cache.remove(key);
        return null;
    }

    public void put(UUID userId, UUID sessionId, ChatStreamContext context) {
        if (userId == null || sessionId == null || context == null) {
            return;
        }
        cache.put(cacheKey(userId, sessionId), new CachedEntry(context, System.currentTimeMillis()));
    }

    public void invalidateRepository(UUID repositoryId) {
        if (repositoryId == null) {
            return;
        }
        synchronized (cache) {
            cache.entrySet().removeIf(e -> repositoryId.equals(e.getValue().context.repositoryId()));
        }
    }

    private static String cacheKey(UUID userId, UUID sessionId) {
        return userId + ":" + sessionId;
    }

    private record CachedEntry(ChatStreamContext context, long cachedAtMs) {}
}
