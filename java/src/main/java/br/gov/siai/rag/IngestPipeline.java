package br.gov.siai.rag;

import com.google.cloud.storage.Blob;
import com.google.cloud.storage.BlobId;
import com.google.cloud.storage.BlobInfo;
import com.google.cloud.storage.Storage;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.io.IOException;
import java.time.Instant;
import java.util.HashMap;
import java.util.Map;

/**
 * Pipeline compartilhado de ingestão de documentos.
 *
 * <p>Usado por:
 * <ul>
 *   <li>Worker HTTP (Cloud Tasks).</li>
 *   <li>Fallback síncrono (quando Cloud Tasks não está configurado).</li>
 * </ul>
 *
 * <p>Espelha: {@code ai_agents/services/ingest_pipeline.py}
 *
 * <p>Depende de: {@link GcpAuth}, {@link StorageClient}, {@link DocumentAiService}
 */
public final class IngestPipeline {

    private static final Logger log = LoggerFactory.getLogger(IngestPipeline.class);

    private IngestPipeline() {}

    // ── Exceções de negócio ───────────────────────────────────────────────────

    /**
     * Erro de negócio/configuração que não deve ser reprocessado.
     * Ao receber este erro, o worker deve dar ACK na tarefa.
     */
    public static class IngestIrrecoverableError extends RuntimeException {
        public IngestIrrecoverableError(String message) { super(message); }
    }

    /**
     * Erro transitório de infraestrutura que pode ser reprocessado.
     * Ao receber este erro, o worker deve dar NACK ou deixar a tarefa expirar.
     */
    public static class IngestRecoverableError extends RuntimeException {
        public IngestRecoverableError(String message, Throwable cause) { super(message, cause); }
    }

    // ── Pipeline principal ────────────────────────────────────────────────────

    /**
     * Executa o pipeline completo de ingestão para um payload JSON.
     *
     * <p>Fluxo:
     * <ol>
     *   <li>Valida blob_name e gcs_uri no payload.</li>
     *   <li>Verifica duplicata (blob já indexado ou indexando → ignora).</li>
     *   <li>Marca blob como {@code "indexando"}.</li>
     *   <li>Baixa bytes do blob.</li>
     *   <li>Se PDF sem texto → OCR via Document AI → salva .txt auxiliar.</li>
     *   <li>Importa no Agent Builder (aguarda até 120s pela LRO).</li>
     *   <li>Atualiza metadata OCR no blob original se aplicável.</li>
     * </ol>
     *
     * @param dados Mapa com campos: blob_name, gcs_uri, nome, categoria, tipo.
     * @return Mapa com campos: {@code status}, {@code duplicata}, {@code ocr_realizado},
     *         {@code ocr_blob_name} (nullable).
     * @throws IngestIrrecoverableError se o payload for inválido ou o blob não existir.
     * @throws IngestRecoverableError   se houver erro transitório de infraestrutura.
     */
    public static Map<String, Object> processarPayloadIngestao(Map<String, Object> dados) {
        String blobName  = getString(dados, "blob_name").strip();
        String gcsUri    = getString(dados, "gcs_uri").strip();
        String nome      = getString(dados, "nome");
        if (nome.isEmpty() && !blobName.isEmpty()) {
            nome = blobName.substring(blobName.lastIndexOf('/') + 1);
        }
        String categoria = getString(dados, "categoria");
        if (categoria.isEmpty()) categoria = "geral";
        String tipo      = getString(dados, "tipo").toLowerCase();

        if (blobName.isEmpty() || gcsUri.isEmpty()) {
            throw new IngestIrrecoverableError(
                    "Payload incompleto (blob_name/gcs_uri ausentes).");
        }

        try {
            GcpAuth.initVertex();
            Storage client = GcpAuth.storageClient();

            // 1. Verifica duplicata.
            Blob blobCheck = client.get(GcpAuth.bucketName(), blobName);
            if (blobCheck == null) {
                throw new IngestIrrecoverableError("Blob inexistente no GCS: " + blobName);
            }
            blobCheck.reload();
            String statusAtual = (blobCheck.getMetadata() != null)
                    ? blobCheck.getMetadata().getOrDefault("status_indexacao", "")
                    : "";
            if ("indexando".equals(statusAtual) || "indexado".equals(statusAtual)) {
                log.info("Duplicata ignorada: '{}' status={}", nome, statusAtual);
                return Map.of("status", statusAtual, "duplicata", true, "ocr_realizado", false);
            }

            // 2. Pré-marca como indexando.
            try {
                blobCheck.reload();
                Map<String, String> meta = new HashMap<>(
                        blobCheck.getMetadata() != null ? blobCheck.getMetadata() : Map.of());
                meta.put("status_indexacao", "indexando");
                blobCheck.toBuilder().setMetadata(meta).build().update();
            } catch (Exception e) {
                log.warn("Não foi possível pré-marcar '{}' como indexando: {}", blobName, e.getMessage());
            }

            // 3. Baixa os bytes.
            byte[] conteudoBytes = StorageClient.baixarBlob(blobName);
            String gcsUriParaIndexar = gcsUri;
            boolean ocrRealizado    = false;
            String ocrBlobName      = null;

            // 4. OCR se PDF sem camada de texto.
            if ("pdf".equals(tipo) && !DocumentAiService.pdfTemTextoExtraivel(conteudoBytes)) {
                String textoOcr = DocumentAiService.extrairTextoPdf(conteudoBytes);
                if (!textoOcr.isBlank()) {
                    String nomeBaseSemExt = nome.contains(".")
                            ? nome.substring(0, nome.lastIndexOf('.'))
                            : nome;
                    ocrBlobName = StorageClient.salvarTextoOcr(
                            nomeBaseSemExt, categoria, textoOcr, blobName);
                    gcsUriParaIndexar = "gs://" + GcpAuth.bucketName() + "/" + ocrBlobName;
                    ocrRealizado = true;
                }
            }

            // 5. Importa no Agent Builder.
            // No worker assíncrono, vale aguardar mais para persistir o status "indexado".
            String status = StorageClient.importarGcsParaVertex(gcsUriParaIndexar, blobName, 120);

            // 6. Atualiza metadata OCR no blob original.
            if (ocrRealizado && ocrBlobName != null) {
                atualizarMetadataOcr(blobName, ocrBlobName, client);
            }

            Map<String, Object> resultado = new HashMap<>();
            resultado.put("status",       status);
            resultado.put("duplicata",    false);
            resultado.put("ocr_realizado", ocrRealizado);
            resultado.put("ocr_blob_name", ocrBlobName);
            return resultado;

        } catch (IngestIrrecoverableError e) {
            marcarBlobErro(blobName, e.getMessage());
            throw e;
        } catch (IllegalArgumentException | IllegalStateException e) {
            marcarBlobErro(blobName, e.getMessage());
            throw new IngestIrrecoverableError(e.getMessage());
        } catch (Exception e) {
            throw new IngestRecoverableError(e.getMessage(), e);
        }
    }

    // ── Helpers privados ──────────────────────────────────────────────────────

    /** Marca o blob com status_indexacao=erro e registra o motivo. */
    private static void marcarBlobErro(String blobName, String motivo) {
        try {
            Storage client = GcpAuth.storageClient();
            Blob blob = client.get(GcpAuth.bucketName(), blobName);
            if (blob == null) return;
            blob.reload();
            Map<String, String> meta = new HashMap<>(
                    blob.getMetadata() != null ? blob.getMetadata() : Map.of());
            meta.put("status_indexacao", "erro");
            meta.put("erro_motivo",  motivo != null ? motivo.substring(0, Math.min(200, motivo.length())) : "");
            meta.put("erro_em",      Instant.now().toString());
            blob.toBuilder().setMetadata(meta).build().update();
        } catch (Exception e) {
            log.warn("Não foi possível marcar blob como erro '{}': {}", blobName, e.getMessage());
        }
    }

    /** Atualiza o metadata do blob original com informações do OCR realizado. */
    private static void atualizarMetadataOcr(
            String blobName, String ocrBlobName, Storage client) {
        try {
            Blob blob = client.get(GcpAuth.bucketName(), blobName);
            if (blob == null) return;
            blob.reload();
            Map<String, String> meta = new HashMap<>(
                    blob.getMetadata() != null ? blob.getMetadata() : Map.of());
            meta.put("ocr_realizado", "true");
            meta.put("ocr_blob",      ocrBlobName);
            meta.put("ocr_em",        Instant.now().toString());
            blob.toBuilder().setMetadata(meta).build().update();
        } catch (Exception e) {
            log.warn("Não foi possível atualizar metadata OCR para '{}': {}", blobName, e.getMessage());
        }
    }

    /** Extrai campo string de um mapa; retorna string vazia se ausente ou nulo. */
    private static String getString(Map<String, Object> map, String key) {
        Object v = map.get(key);
        return (v != null) ? String.valueOf(v) : "";
    }
}
