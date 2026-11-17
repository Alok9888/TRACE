package trace.backend.config;

import java.util.concurrent.Executor;

import org.springframework.ai.chat.model.ChatModel;
import org.springframework.ai.google.genai.GoogleGenAiChatModel;
import org.springframework.ai.google.genai.GoogleGenAiChatOptions;
import org.springframework.ai.model.tool.ToolCallingManager;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.core.retry.RetryPolicy;
import org.springframework.core.retry.RetryTemplate;
import org.springframework.core.task.AsyncTaskExecutor;
import org.springframework.core.task.SimpleAsyncTaskExecutor;
import org.springframework.scheduling.annotation.EnableAsync;

import com.google.genai.Client;
import io.micrometer.observation.ObservationRegistry;

@Configuration
@EnableAsync
public class AppConfig {
    // Gemini API key for last-resort chat fallback
    @Value("${spring.ai.google.genai.api-key:}")
    private String geminiApiKey;

    @Bean(name = "geminiFallbackChatModel")
    ChatModel geminiFallbackChatModel(
            ToolCallingManager toolCallingManager,
            RetryTemplate retryTemplate,
            ObservationRegistry observationRegistry) {
        // Create a GenAi client directly from the API key
        Client genAiClient = Client.builder()
                .apiKey(geminiApiKey)
                .build();

        return GoogleGenAiChatModel.builder()
                .genAiClient(genAiClient)
                .options(GoogleGenAiChatOptions.builder().model("gemini-2.5-flash").build())
                .toolCallingManager(toolCallingManager)
                .retryTemplate(retryTemplate)
                .observationRegistry(observationRegistry)
                .build();
    }

    @Bean
    RetryTemplate genAiSingleAttemptRetryTemplate() {
        // Quota fallback is model-to-model; repeating the same request burns latency and quota.
        return new RetryTemplate(RetryPolicy.withMaxRetries(0));
    }

    @Bean(name = "indexingExecutor")
    Executor indexingExecutor() {
        SimpleAsyncTaskExecutor executor = new SimpleAsyncTaskExecutor("index-");
        executor.setVirtualThreads(true);
        executor.setConcurrencyLimit(4);
        return executor;
    }

    /**
     * Dedicated virtual-thread I/O executor for concurrent GitHub fetching, Cloudflare embedding batches,
     * and async DB writes so tasks never serialize onto ForkJoinPool.commonPool() on 1-2 vCPU containers.
     */
    @Bean(name = "ioExecutor")
    AsyncTaskExecutor ioExecutor() {
        SimpleAsyncTaskExecutor executor = new SimpleAsyncTaskExecutor("io-");
        executor.setVirtualThreads(true);
        executor.setConcurrencyLimit(32);
        return executor;
    }

    @Bean(name = "chatExecutor")
    AsyncTaskExecutor chatExecutor() {
        SimpleAsyncTaskExecutor executor = new SimpleAsyncTaskExecutor("chat-");
        executor.setVirtualThreads(true);
        executor.setConcurrencyLimit(32);
        return executor;
    }

    @Bean(name = "ragExecutor")
    AsyncTaskExecutor ragExecutor() {
        SimpleAsyncTaskExecutor executor = new SimpleAsyncTaskExecutor("rag-");
        executor.setVirtualThreads(true);
        executor.setConcurrencyLimit(16);
        return executor;
    }
}