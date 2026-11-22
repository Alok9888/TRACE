package trace.backend.entity;

/**
 * Discriminator identifying the origin type of an indexed knowledge source.
 */
public enum SourceType {
    GITHUB_REPO,
    PDF,
    NOTEBOOK,
    IAC,
    EPUB
}
