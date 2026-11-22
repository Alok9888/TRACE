package trace.backend.services.ingestion;

/**
 * A single semantic unit extracted from an uploaded document or config file.
 *
 * @param sectionHeading Human-readable heading or block signature (may be null if none detected)
 * @param unitNumber     1-based page, chapter, cell, or starting line number
 * @param content        Normalized plain text / markdown / config text for this unit
 */
public record ExtractedSection(
        String sectionHeading,
        int unitNumber,
        String content) {
}
