package trace.backend;

import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.*;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.util.List;
import java.util.Optional;
import java.util.UUID;
import java.util.concurrent.Executor;

import org.apache.pdfbox.pdmodel.PDDocument;
import org.apache.pdfbox.pdmodel.PDPage;
import org.apache.pdfbox.pdmodel.PDPageContentStream;
import org.apache.pdfbox.pdmodel.font.PDType1Font;
import org.apache.pdfbox.pdmodel.font.Standard14Fonts;
import org.junit.jupiter.api.Test;
import org.mockito.ArgumentCaptor;
import org.springframework.ai.document.Document;
import org.springframework.ai.vectorstore.VectorStore;
import org.springframework.mock.web.MockMultipartFile;
import org.springframework.test.util.ReflectionTestUtils;

import tools.jackson.databind.json.JsonMapper;
import trace.backend.dto.CitationDto;
import trace.backend.entity.IndexStatus;
import trace.backend.entity.Repository;
import trace.backend.entity.SourceType;
import trace.backend.exceptions.BadRequestException;
import trace.backend.repository.RepositoryRepository;
import trace.backend.services.ai.ChatPromptBuilder;
import trace.backend.services.ai.CitationMapper;
import trace.backend.services.ai.RagSettings;
import trace.backend.services.indexing.VectorBatchPersister;
import trace.backend.services.ingestion.PdfChunker;
import trace.backend.services.ingestion.PdfIngestionService;
import trace.backend.services.ingestion.PdfTextExtractor;

class PdfIngestionTest {

    @Test
    void extractsMultiPagePdfStripsRepeatedHeadersAndPreservesPageBoundaries() throws IOException {
        byte[] pdfBytes = createMultiPagePdf(List.of(
                List.of(
                        "ACME TECHNICAL SPECIFICATION",
                        "1. System Architecture",
                        "TRACE uses a unified 384-dimensional PgVector store for both repositories and PDF documents.",
                        "Every vector chunk carries workspace and source provenance metadata for strict isolation.",
                        "Page 1 of 3"),
                List.of(
                        "ACME TECHNICAL SPECIFICATION",
                        "2. Retrieval Pipeline",
                        "Direct SQL expression indexing avoids full table scans during similarity search.",
                        "Retrieved passages are bounded to fit cleanly inside the low-latency token budget.",
                        "Page 2 of 3"),
                List.of(
                        "ACME TECHNICAL SPECIFICATION",
                        "3. Operational Telemetry",
                        "Streaming Server-Sent Events deliver tokens directly from Groq with Gemini fallback.",
                        "Page 3 of 3")
        ));

        PdfTextExtractor extractor = new PdfTextExtractor();
        PdfTextExtractor.ExtractionResult result = extractor.extract(pdfBytes);

        assertEquals(3, result.totalPages());
        assertEquals(3, result.pages().size());

        // Repeated header "ACME TECHNICAL SPECIFICATION" and standalone page numbers should be stripped
        for (int i = 0; i < 3; i++) {
            PdfTextExtractor.ExtractedPage page = result.pages().get(i);
            assertEquals(i + 1, page.pageNumber());
            assertFalse(page.text().contains("ACME TECHNICAL SPECIFICATION"),
                    "Repeated running header should be stripped on page " + page.pageNumber());
            assertFalse(page.text().contains("Page " + (i + 1) + " of 3"),
                    "Standalone page footer should be stripped on page " + page.pageNumber());
        }

        assertEquals("1. System Architecture", result.pages().get(0).primaryHeading());
        assertEquals("2. Retrieval Pipeline", result.pages().get(1).primaryHeading());
        assertEquals("3. Operational Telemetry", result.pages().get(2).primaryHeading());
    }

    @Test
    void rejectsScannedOrBlankPdfWithClearError() throws IOException {
        byte[] blankPdf = createBlankPdf(2);
        PdfTextExtractor extractor = new PdfTextExtractor();

        BadRequestException ex = assertThrows(BadRequestException.class, () -> extractor.extract(blankPdf));
        assertTrue(ex.getMessage().toLowerCase().contains("scanned")
                || ex.getMessage().toLowerCase().contains("no extractable text"),
                "Unexpected error message: " + ex.getMessage());
    }

    @Test
    void rejectsFakePdfWithInvalidMagicHeader() {
        RepositoryRepository repoRepo = mock(RepositoryRepository.class);
        VectorStore vectorStore = mock(VectorStore.class);
        PdfIngestionService service = new PdfIngestionService(
                repoRepo,
                new PdfTextExtractor(),
                new PdfChunker(1500),
                new VectorBatchPersister(vectorStore));

        MockMultipartFile fakePdf = new MockMultipartFile(
                "file", "fake.pdf", "application/pdf", "not a real pdf payload".getBytes());

        BadRequestException ex = assertThrows(
                BadRequestException.class,
                () -> service.ingest(UUID.randomUUID(), fakePdf));
        assertTrue(ex.getMessage().toLowerCase().contains("valid pdf"),
                "Expected invalid PDF header error, got: " + ex.getMessage());
        verify(repoRepo, never()).save(any());
    }

    @Test
    void chunksPagesPreservingPageNumbersSectionHeadingsAndMetadata() throws IOException {
        String longPara = "Distributed vector retrieval requires deterministic chunking boundaries so citations remain accurate. ".repeat(14);
        byte[] pdfBytes = createMultiPagePdf(List.of(
                List.of("1. Introduction", longPara),
                List.of("2. Benchmarks", "Latency remains under 300ms for cached workspace sessions across all source types.")
        ));

        PdfTextExtractor extractor = new PdfTextExtractor();
        PdfTextExtractor.ExtractionResult extracted = extractor.extract(pdfBytes);

        PdfChunker chunker = new PdfChunker(600);
        UUID userId = UUID.randomUUID();
        String sourceId = UUID.randomUUID().toString();
        List<Document> docs = chunker.chunkPages(userId, sourceId, "architecture.pdf", extracted.pages());

        assertTrue(docs.size() >= 3, "Expected page 1 to split into multiple chunks + page 2 chunk");

        Document first = docs.get(0);
        assertTrue(first.getText().startsWith("[Document: architecture.pdf | Page 1"));
        assertEquals(sourceId, first.getMetadata().get(RagSettings.METADATA_REPO_ID));
        assertEquals(userId.toString(), first.getMetadata().get(RagSettings.METADATA_USER_ID));
        assertEquals("PDF", first.getMetadata().get(RagSettings.METADATA_SOURCE_TYPE));
        assertEquals("architecture.pdf", first.getMetadata().get("filePath"));
        assertEquals(1, first.getMetadata().get(RagSettings.METADATA_PAGE_NUMBER));
        assertEquals("1. Introduction", first.getMetadata().get(RagSettings.METADATA_SECTION_HEADING));
        assertEquals(0, first.getMetadata().get("chunkIndex"));

        Document last = docs.get(docs.size() - 1);
        assertEquals(2, last.getMetadata().get(RagSettings.METADATA_PAGE_NUMBER));
        assertEquals("2. Benchmarks", last.getMetadata().get(RagSettings.METADATA_SECTION_HEADING));
        assertEquals(docs.size() - 1, last.getMetadata().get("chunkIndex"));
    }

    @Test
    void endToEndPdfIngestionPersistsVectorsAndMarksSourceReady() throws IOException {
        byte[] pdfBytes = createMultiPagePdf(List.of(
                List.of("1. Overview", "TRACE ingests PDF documents directly into PgVector alongside GitHub repositories with zero schema duplication."),
                List.of("2. Citations", "Every retrieved PDF chunk retains page number and section heading provenance for transparent citations.")
        ));

        RepositoryRepository repoRepo = mock(RepositoryRepository.class);
        VectorStore vectorStore = mock(VectorStore.class);
        VectorBatchPersister persister = new VectorBatchPersister(vectorStore);

        UUID assignedId = UUID.randomUUID();
        Repository[] savedHolder = new Repository[1];
        when(repoRepo.save(any(Repository.class))).thenAnswer(inv -> {
            Repository r = inv.getArgument(0);
            if (r.getId() == null) {
                r.setId(assignedId);
            }
            savedHolder[0] = r;
            return r;
        });
        when(repoRepo.findById(assignedId)).thenAnswer(inv -> Optional.ofNullable(savedHolder[0]));

        PdfIngestionService service = new PdfIngestionService(
                repoRepo, new PdfTextExtractor(), new PdfChunker(1500), persister);
        // Run async pipeline synchronously on test thread for deterministic verification
        ReflectionTestUtils.setField(service, "indexingExecutor", (Executor) Runnable::run);

        MockMultipartFile upload = new MockMultipartFile(
                "file", "whitepaper.pdf", "application/pdf", pdfBytes);

        Repository source = service.ingest(UUID.randomUUID(), upload);

        assertEquals(assignedId, source.getId());
        assertEquals(SourceType.PDF, savedHolder[0].effectiveSourceType());
        assertEquals(IndexStatus.READY, savedHolder[0].getIndexStatus());
        assertEquals("whitepaper.pdf", savedHolder[0].getFileName());
        assertEquals(2, savedHolder[0].getPageCount());
        assertTrue(savedHolder[0].getChunkCount() >= 2);
        assertNull(savedHolder[0].getHtmlUrl());

        @SuppressWarnings("unchecked")
        ArgumentCaptor<List<Document>> batchCaptor = ArgumentCaptor.forClass(List.class);
        verify(vectorStore, atLeastOnce()).add(batchCaptor.capture());
        List<Document> persistedDocs = batchCaptor.getAllValues().stream().flatMap(List::stream).toList();
        assertEquals(savedHolder[0].getChunkCount(), persistedDocs.size());
        assertEquals("PDF", persistedDocs.get(0).getMetadata().get(RagSettings.METADATA_SOURCE_TYPE));
    }

    @Test
    void citationMapperSupportsPdfMetadataAndBackwardCompatibleLegacyJson() {
        CitationMapper mapper = new CitationMapper(JsonMapper.builder().build());

        Document pdfDoc = new Document("passage", java.util.Map.of(
                "filePath", "manual.pdf",
                "language", "pdf",
                RagSettings.METADATA_SOURCE_TYPE, "PDF",
                RagSettings.METADATA_PAGE_NUMBER, 7,
                RagSettings.METADATA_SECTION_HEADING, "3.2 Deployment",
                "chunkIndex", 12
        ));
        CitationDto dto = mapper.fromDocument(pdfDoc);
        assertEquals("manual.pdf", dto.filePath());
        assertEquals("PDF", dto.sourceType());
        assertEquals(7, dto.pageNumber());
        assertEquals("3.2 Deployment", dto.sectionHeading());
        assertEquals(12, dto.chunkIndex());
        assertNull(dto.startLine());

        // Legacy 4-field JSON persisted prior to multi-source upgrade still deserializes cleanly
        String legacyJson = "[{\"filePath\":\"src/Main.java\",\"startLine\":10,\"endLine\":24,\"language\":\"java\"}]";
        List<CitationDto> parsed = mapper.fromJson(legacyJson);
        assertEquals(1, parsed.size());
        assertEquals("src/Main.java", parsed.get(0).filePath());
        assertEquals(10, parsed.get(0).startLine());
        assertNull(parsed.get(0).pageNumber());
    }

    @Test
    void promptBuilderAdaptsCitationInstructionsToSourceType() {
        ChatPromptBuilder builder = new ChatPromptBuilder();

        String pdfPrompt = builder.systemPrompt(
                "quarterly-report.pdf", SourceType.PDF, ChatPromptBuilder.QueryTier.STANDARD, null);
        assertTrue(pdfPrompt.contains("document analyst"));
        assertTrue(pdfPrompt.contains("page numbers"));
        assertTrue(pdfPrompt.contains("section headings"));
        assertFalse(pdfPrompt.contains("codebase"));

        String repoPrompt = builder.systemPrompt(
                "owner/repo", SourceType.GITHUB_REPO, ChatPromptBuilder.QueryTier.STANDARD, null);
        assertTrue(repoPrompt.contains("codebase"));
        assertTrue(repoPrompt.contains("file paths and line ranges"));

        String pdfUser = builder.userPrompt("passage", "What is Q4 revenue?", SourceType.PDF);
        assertTrue(pdfUser.startsWith("Document context:"));
    }

    private static byte[] createMultiPagePdf(List<List<String>> pagesLines) throws IOException {
        try (PDDocument doc = new PDDocument();
             ByteArrayOutputStream out = new ByteArrayOutputStream()) {
            PDType1Font font = new PDType1Font(Standard14Fonts.FontName.HELVETICA);
            for (List<String> lines : pagesLines) {
                PDPage page = new PDPage();
                doc.addPage(page);
                try (PDPageContentStream cs = new PDPageContentStream(doc, page)) {
                    cs.beginText();
                    cs.setFont(font, 11);
                    cs.setLeading(15f);
                    cs.newLineAtOffset(50, 740);
                    for (String line : lines) {
                        // Wrap long lines so PDFBox keeps them cleanly on page
                        int chunk = 85;
                        for (int idx = 0; idx < line.length(); idx += chunk) {
                            String slice = line.substring(idx, Math.min(line.length(), idx + chunk));
                            cs.showText(slice);
                            cs.newLine();
                        }
                        cs.newLine();
                    }
                    cs.endText();
                }
            }
            doc.save(out);
            return out.toByteArray();
        }
    }

    private static byte[] createBlankPdf(int pageCount) throws IOException {
        try (PDDocument doc = new PDDocument();
             ByteArrayOutputStream out = new ByteArrayOutputStream()) {
            for (int i = 0; i < pageCount; i++) {
                doc.addPage(new PDPage());
            }
            doc.save(out);
            return out.toByteArray();
        }
    }
}
