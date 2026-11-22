package trace.backend.services.ingestion;

import java.nio.file.Path;
import java.util.List;

import trace.backend.entity.SourceType;

/**
 * Strategy interface for format-specific streaming document extractors.
 * Implementations must operate within TRACE's -Xmx160m JVM heap budget by streaming
 * from {@code tempFile} rather than buffering entire raw archives or binary blobs in memory.
 */
public interface DocumentExtractor {

    SourceType getSourceType();

    boolean supports(String originalFilename, String contentType);

    List<ExtractedSection> extract(Path tempFile, String originalFilename);
}
