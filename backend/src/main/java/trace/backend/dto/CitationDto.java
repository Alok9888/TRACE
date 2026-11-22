package trace.backend.dto;

public record CitationDto(
        String filePath,
        Integer startLine,
        Integer endLine,
        String language,
        String sourceType,
        Integer pageNumber,
        String sectionHeading,
        Integer chunkIndex) {

    public CitationDto(
            String filePath,
            Integer startLine,
            Integer endLine,
            String language) {
        this(filePath, startLine, endLine, language, null, null, null, null);
    }
}
