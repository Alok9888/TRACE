package trace.backend.services.ingestion;

import java.util.UUID;

import trace.backend.entity.Repository;
import trace.backend.entity.SourceType;

/**
 * Strategy interface for source-specific ingestion adapters.
 * Each adapter owns source acquisition, validation, text/code extraction, and source-aware chunking,
 * while feeding chunks into the exact same shared embedding + PgVector indexing pipeline.
 */
public interface SourceIngestionAdapter<R> {

    SourceType supportedType();

    Repository ingest(UUID workspaceId, R request);
}
