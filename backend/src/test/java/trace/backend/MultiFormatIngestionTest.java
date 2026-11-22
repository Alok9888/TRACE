package trace.backend;

import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.*;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.Optional;
import java.util.UUID;
import java.util.concurrent.Executor;
import java.util.zip.ZipEntry;
import java.util.zip.ZipOutputStream;

import org.junit.jupiter.api.Test;
import org.mockito.ArgumentCaptor;
import org.springframework.ai.document.Document;
import org.springframework.ai.vectorstore.VectorStore;
import org.springframework.mock.web.MockMultipartFile;
import org.springframework.test.util.ReflectionTestUtils;

import trace.backend.entity.IndexStatus;
import trace.backend.entity.Repository;
import trace.backend.entity.SourceType;
import trace.backend.exceptions.BadRequestException;
import trace.backend.repository.RepositoryRepository;
import trace.backend.services.ai.ChatPromptBuilder;
import trace.backend.services.ai.RagSettings;
import trace.backend.services.indexing.VectorBatchPersister;
import trace.backend.services.ingestion.EpubExtractor;
import trace.backend.services.ingestion.ExtractedSection;
import trace.backend.services.ingestion.FileIngestionService;
import trace.backend.services.ingestion.IacExtractor;
import trace.backend.services.ingestion.NotebookExtractor;
import trace.backend.services.ingestion.PdfTextExtractor;
import trace.backend.services.ingestion.SemanticChunker;

class MultiFormatIngestionTest {

    @Test
    void notebookExtractorSkipsBase64OutputsAndPairsMarkdownWithCode() throws IOException {
        String hugeBase64Blob = "iVBORw0KGgoAAAANSUhEUgAA".repeat(4000);
        String notebookJson = """
                {
                  "nbformat": 4,
                  "nbformat_minor": 5,
                  "metadata": {
                    "kernelspec": { "display_name": "Python 3", "language": "python", "name": "python3" }
                  },
                  "cells": [
                    {
                      "cell_type": "markdown",
                      "metadata": {},
                      "source": ["# Feature Pipeline\\n", "Load raw telemetry events and drop outliers."]
                    },
                    {
                      "cell_type": "code",
                      "execution_count": 1,
                      "metadata": { "collapsed": false },
                      "source": ["import pandas as pd\\n", "df = pd.read_parquet('events.parquet')\\n", "df = df[df['latency_ms'] < 5000]"],
                      "outputs": [
                        {
                          "output_type": "display_data",
                          "data": { "image/png": "%s" },
                          "metadata": {}
                        }
                      ]
                    },
                    {
                      "cell_type": "markdown",
                      "metadata": {},
                      "source": ["## Model Evaluation\\n", "Compute p95 error across validation folds."]
                    },
                    {
                      "cell_type": "code",
                      "execution_count": 2,
                      "metadata": {},
                      "source": ["p95 = df['error'].quantile(0.95)\\nprint(p95)"],
                      "outputs": []
                    }
                  ]
                }
                """.formatted(hugeBase64Blob);

        Path temp = Files.createTempFile("test-nb-", ".ipynb");
        try {
            Files.writeString(temp, notebookJson, StandardCharsets.UTF_8);
            NotebookExtractor extractor = new NotebookExtractor();
            List<ExtractedSection> sections = extractor.extract(temp, "pipeline.ipynb");

            assertEquals(2, sections.size(), "Markdown + code cells should pair into 2 contextual sections");
            ExtractedSection first = sections.get(0);
            assertEquals("Feature Pipeline", first.sectionHeading());
            assertEquals(2, first.unitNumber());
            assertTrue(first.content().contains("Load raw telemetry events"));
            assertTrue(first.content().contains("```python\nimport pandas as pd"));
            assertFalse(first.content().contains("iVBORw0KGgo"), "Base64 output blob must never be extracted");

            ExtractedSection second = sections.get(1);
            assertEquals("Model Evaluation", second.sectionHeading());
            assertEquals(4, second.unitNumber());
            assertTrue(second.content().contains("quantile(0.95)"));
        } finally {
            Files.deleteIfExists(temp);
        }
    }

    @Test
    void notebookExtractorRejectsEmptyNotebook() throws IOException {
        Path temp = Files.createTempFile("empty-nb-", ".ipynb");
        try {
            Files.writeString(temp, "{\"cells\":[{\"cell_type\":\"code\",\"source\":[],\"outputs\":[]}]}", StandardCharsets.UTF_8);
            NotebookExtractor extractor = new NotebookExtractor();
            assertThrows(BadRequestException.class, () -> extractor.extract(temp, "empty.ipynb"));
        } finally {
            Files.deleteIfExists(temp);
        }
    }

    @Test
    void iacExtractorSplitsTerraformDockerfileComposeAndGithubActionsSemantically() {
        IacExtractor extractor = new IacExtractor();

        // 1. Terraform HCL blocks with brace inside string literal
        String tf = """
                variable "region" {
                  default = "us-east-1"
                }

                resource "aws_ecs_service" "worker" {
                  name = "trace-worker-{env}"
                  desired_count = 2
                  deployment_circuit_breaker {
                    enable = true
                  }
                }
                """;
        List<ExtractedSection> tfBlocks = extractor.extractFromString(tf, "main.tf");
        assertEquals(2, tfBlocks.size());
        assertEquals("variable \"region\"", tfBlocks.get(0).sectionHeading());
        assertEquals(1, tfBlocks.get(0).unitNumber());
        assertEquals("resource \"aws_ecs_service\" \"worker\"", tfBlocks.get(1).sectionHeading());
        assertEquals(5, tfBlocks.get(1).unitNumber());
        assertTrue(tfBlocks.get(1).content().contains("deployment_circuit_breaker"));

        // 2. Multi-stage Dockerfile
        String dockerfile = """
                FROM maven:3.9-eclipse-temurin-21 AS builder
                WORKDIR /app
                RUN mvn -B package -DskipTests

                FROM eclipse-temurin:21-jre-alpine AS runtime
                COPY --from=builder /app/target/app.jar /app.jar
                ENTRYPOINT ["java", "-Xmx160m", "-jar", "/app.jar"]
                """;
        List<ExtractedSection> dockerStages = extractor.extractFromString(dockerfile, "Dockerfile");
        assertEquals(2, dockerStages.size());
        assertEquals("Stage: builder", dockerStages.get(0).sectionHeading());
        assertEquals(1, dockerStages.get(0).unitNumber());
        assertEquals("Stage: runtime", dockerStages.get(1).sectionHeading());
        assertEquals(5, dockerStages.get(1).unitNumber());

        // 3. Docker Compose services
        String compose = """
                services:
                  api:
                    build: ./backend
                    ports:
                      - "8080:8080"
                  postgres:
                    image: pgvector/pgvector:pg16
                """;
        List<ExtractedSection> composeBlocks = extractor.extractFromString(compose, "docker-compose.yml");
        assertEquals(2, composeBlocks.size());
        assertEquals("service: api", composeBlocks.get(0).sectionHeading());
        assertEquals("service: postgres", composeBlocks.get(1).sectionHeading());

        // 4. GitHub Actions workflow jobs
        String workflow = """
                name: CI
                on: [push]

                jobs:
                  test:
                    runs-on: ubuntu-latest
                    steps:
                      - run: ./mvnw test
                  deploy:
                    needs: test
                    runs-on: ubuntu-latest
                """;
        List<ExtractedSection> jobBlocks = extractor.extractFromString(workflow, "ci.yml");
        assertEquals(3, jobBlocks.size());
        assertEquals("config: ci.yml", jobBlocks.get(0).sectionHeading());
        assertEquals("job: test", jobBlocks.get(1).sectionHeading());
        assertEquals("job: deploy", jobBlocks.get(2).sectionHeading());
    }

    @Test
    void epubExtractorFollowsSpineOrderPreservesCodeBlocksAndRejectsDrm() throws IOException {
        Path validEpub = createTestEpub(false);
        Path drmEpub = createTestEpub(true);
        try {
            EpubExtractor extractor = new EpubExtractor();
            List<ExtractedSection> chapters = extractor.extract(validEpub, "systems-design.epub");

            assertEquals(2, chapters.size(), "Nav document must be skipped, leaving 2 linear spine chapters");
            assertEquals(1, chapters.get(0).unitNumber());
            assertEquals("Chapter 1: Storage Engines", chapters.get(0).sectionHeading());
            assertTrue(chapters.get(0).content().contains("LSM-trees append writes sequentially"));
            assertTrue(chapters.get(0).content().contains("```\nSELECT * FROM trace_vectors;\n```"));

            assertEquals(2, chapters.get(1).unitNumber());
            assertEquals("Chapter 2: Consensus Protocols", chapters.get(1).sectionHeading());
            assertTrue(chapters.get(1).content().contains("Raft elects a single leader"));

            BadRequestException drmEx = assertThrows(
                    BadRequestException.class,
                    () -> extractor.extract(drmEpub, "locked.epub"));
            assertTrue(drmEx.getMessage().toLowerCase().contains("drm"));
        } finally {
            Files.deleteIfExists(validEpub);
            Files.deleteIfExists(drmEpub);
        }
    }

    @Test
    void semanticChunkerFormatsHeadersAndMetadataForAllSourceTypes() {
        SemanticChunker chunker = new SemanticChunker(1500);
        UUID userId = UUID.randomUUID();
        String sourceId = UUID.randomUUID().toString();

        List<Document> epubDocs = chunker.chunkSections(
                userId, sourceId, SourceType.EPUB, "ddia.epub",
                List.of(new ExtractedSection("Replication", 5, "Leader-based replication streams WAL entries.")));
        assertTrue(epubDocs.get(0).getText().startsWith("[Book: ddia.epub | Chapter 5 | Section: Replication]\n"));
        assertEquals("EPUB", epubDocs.get(0).getMetadata().get(RagSettings.METADATA_SOURCE_TYPE));
        assertEquals(5, epubDocs.get(0).getMetadata().get(RagSettings.METADATA_PAGE_NUMBER));

        List<Document> nbDocs = chunker.chunkSections(
                userId, sourceId, SourceType.NOTEBOOK, "train.ipynb",
                List.of(new ExtractedSection("Data Prep", 3, "Normalize features before training.")));
        assertTrue(nbDocs.get(0).getText().startsWith("[Notebook: train.ipynb | Cell 3 | Section: Data Prep]\n"));
        assertEquals("NOTEBOOK", nbDocs.get(0).getMetadata().get(RagSettings.METADATA_SOURCE_TYPE));

        List<Document> iacDocs = chunker.chunkSections(
                userId, sourceId, SourceType.IAC, "main.tf",
                List.of(new ExtractedSection("resource \"aws_s3_bucket\" \"logs\"", 12, "resource \"aws_s3_bucket\" \"logs\" {}")));
        assertTrue(iacDocs.get(0).getText().startsWith("[Config: main.tf | Line 12 | Block: resource \"aws_s3_bucket\" \"logs\"]\n"));
        assertEquals("IAC", iacDocs.get(0).getMetadata().get(RagSettings.METADATA_SOURCE_TYPE));
        assertEquals(12, iacDocs.get(0).getMetadata().get("startLine"));
    }

    @Test
    void fileIngestionServiceDeduplicatesBySha256AndPersistsNewUploads() {
        RepositoryRepository repoRepo = mock(RepositoryRepository.class);
        VectorStore vectorStore = mock(VectorStore.class);
        FileIngestionService service = new FileIngestionService(
                repoRepo,
                List.of(new PdfTextExtractor(), new NotebookExtractor(), new IacExtractor(), new EpubExtractor()),
                new SemanticChunker(1500),
                new VectorBatchPersister(vectorStore));
        ReflectionTestUtils.setField(service, "indexingExecutor", (Executor) Runnable::run);

        UUID workspaceId = UUID.randomUUID();
        UUID assignedId = UUID.randomUUID();
        Repository[] savedHolder = new Repository[1];
        when(repoRepo.findFirstByUserIdAndTreeShaAndSourceTypeAndIndexStatus(
                eq(workspaceId), any(), eq(SourceType.IAC), eq(IndexStatus.READY)))
                .thenAnswer(inv -> savedHolder[0] != null && savedHolder[0].getIndexStatus() == IndexStatus.READY
                        ? Optional.of(savedHolder[0])
                        : Optional.empty());
        when(repoRepo.save(any(Repository.class))).thenAnswer(inv -> {
            Repository r = inv.getArgument(0);
            if (r.getId() == null) r.setId(assignedId);
            savedHolder[0] = r;
            return r;
        });
        when(repoRepo.findById(assignedId)).thenAnswer(inv -> Optional.ofNullable(savedHolder[0]));

        byte[] tfBytes = "resource \"aws_ecs_service\" \"worker\" {\n  desired_count = 2\n}\n"
                .getBytes(StandardCharsets.UTF_8);
        MockMultipartFile firstUpload = new MockMultipartFile("file", "ecs.tf", "text/plain", tfBytes);

        Repository first = service.ingest(workspaceId, firstUpload);
        assertEquals(assignedId, first.getId());
        assertEquals(SourceType.IAC, savedHolder[0].effectiveSourceType());
        assertEquals(IndexStatus.READY, savedHolder[0].getIndexStatus());
        assertEquals(1, savedHolder[0].getChunkCount());

        @SuppressWarnings("unchecked")
        ArgumentCaptor<List<Document>> batchCaptor = ArgumentCaptor.forClass(List.class);
        verify(vectorStore, times(1)).add(batchCaptor.capture());

        // Second identical upload short-circuits via SHA-256 deduplication without extra vectorStore.add
        MockMultipartFile duplicateUpload = new MockMultipartFile("file", "ecs.tf", "text/plain", tfBytes);
        Repository second = service.ingest(workspaceId, duplicateUpload);
        assertEquals(assignedId, second.getId());
        verify(vectorStore, times(1)).add(any());
    }

    @Test
    void promptBuilderGeneratesFormatNativeCitationInstructions() {
        ChatPromptBuilder builder = new ChatPromptBuilder();

        String epubPrompt = builder.systemPrompt("ddia.epub", SourceType.EPUB, ChatPromptBuilder.QueryTier.STANDARD, null);
        assertTrue(epubPrompt.contains("Chapter 3"));
        assertTrue(builder.userPrompt("text", "q", SourceType.EPUB).startsWith("Book context:"));

        String nbPrompt = builder.systemPrompt("train.ipynb", SourceType.NOTEBOOK, ChatPromptBuilder.QueryTier.STANDARD, null);
        assertTrue(nbPrompt.contains("Cell 7"));
        assertTrue(builder.userPrompt("text", "q", SourceType.NOTEBOOK).startsWith("Notebook context:"));

        String iacPrompt = builder.systemPrompt("main.tf", SourceType.IAC, ChatPromptBuilder.QueryTier.STANDARD, null);
        assertTrue(iacPrompt.contains("Block:"));
        assertTrue(builder.userPrompt("text", "q", SourceType.IAC).startsWith("Infrastructure config context:"));
    }

    private static Path createTestEpub(boolean withDrm) throws IOException {
        Path temp = Files.createTempFile("test-book-", ".epub");
        try (ByteArrayOutputStream baos = new ByteArrayOutputStream();
             ZipOutputStream zos = new ZipOutputStream(baos)) {
            addZipText(zos, "mimetype", "application/epub+zip");
            addZipText(zos, "META-INF/container.xml", """
                    <?xml version="1.0"?>
                    <container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
                      <rootfiles>
                        <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
                      </rootfiles>
                    </container>
                    """);
            if (withDrm) {
                addZipText(zos, "META-INF/encryption.xml", """
                        <encryption xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
                          <EncryptedData xmlns="http://www.w3.org/2001/04/xmlenc#">
                            <CipherData><CipherReference URI="OEBPS/ch1.xhtml"/></CipherData>
                          </EncryptedData>
                        </encryption>
                        """);
            }
            addZipText(zos, "OEBPS/content.opf", """
                    <?xml version="1.0" encoding="UTF-8"?>
                    <package version="3.0" xmlns="http://www.idpf.org/2007/opf">
                      <manifest>
                        <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
                        <item id="ch1" href="ch1.xhtml" media-type="application/xhtml+xml"/>
                        <item id="ch2" href="ch2.xhtml" media-type="application/xhtml+xml"/>
                        <item id="css" href="style.css" media-type="text/css"/>
                      </manifest>
                      <spine>
                        <itemref idref="nav"/>
                        <itemref idref="ch1"/>
                        <itemref idref="ch2"/>
                      </spine>
                    </package>
                    """);
            addZipText(zos, "OEBPS/nav.xhtml", "<html><body><nav>Table of Contents</nav></body></html>");
            addZipText(zos, "OEBPS/ch1.xhtml", """
                    <html><head><title>Storage</title></head><body>
                      <h1>Chapter 1: Storage Engines</h1>
                      <p>LSM-trees append writes sequentially and merge SSTables in the background for high write throughput.</p>
                      <pre>SELECT * FROM trace_vectors;</pre>
                    </body></html>
                    """);
            addZipText(zos, "OEBPS/ch2.xhtml", """
                    <html><head><title>Consensus</title></head><body>
                      <h1>Chapter 2: Consensus Protocols</h1>
                      <p>Raft elects a single leader per term and replicates log entries across a strict quorum of nodes.</p>
                    </body></html>
                    """);
            zos.finish();
            Files.write(temp, baos.toByteArray());
        }
        return temp;
    }

    private static void addZipText(ZipOutputStream zos, String name, String content) throws IOException {
        zos.putNextEntry(new ZipEntry(name));
        zos.write(content.getBytes(StandardCharsets.UTF_8));
        zos.closeEntry();
    }
}
