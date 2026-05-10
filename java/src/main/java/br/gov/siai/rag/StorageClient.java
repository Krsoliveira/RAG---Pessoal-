package br.gov.siai.rag;

import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.google.cloud.storage.*;
import com.google.cloud.discoveryengine.v1.*;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.time.*;
import java.time.format.DateTimeFormatter;
import java.util.*;
import java.util.regex.Pattern;
import java.util.stream.Collectors;
import java.util.stream.StreamSupport;

/**
 * Operações no Cloud Storage e CRUD de documentos.
 *
 * <p>Responsabilidade: qualquer leitura ou escrita de blobs no bucket GCS passa
 * por este módulo — upload de documentos, remoção, listagem, JSON de estado.
 *
 * <p>Espelha: {@code ai_agents/services/storage_client.py}
 *
 * <p>Depende de: {@link GcpAuth}
 */
public final class StorageClient {

    private static final Logger log = LoggerFactory.getLogger(StorageClient.class);
    private static final ObjectMapper MAPPER = new ObjectMapper();

    // Janela de tempo (segundos) em que um blob recém-criado é considerado "indexando".
    private static final long INDEX_GRACE_SECONDS = 20L * 60;

    // MIME types aceitos para upload de documentos base.
    private static final Map<String, String> MIME_TYPES = Map.of(
            "pdf",  "application/pdf",
            "docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            "txt",  "text/plain"
    );

    // Regex para remover prefixo de ID gerado automaticamente no nome do arquivo.
    private static final Pattern PREFIX_PATTERN =
            Pattern.compile("^(?:\\d+|[a-f0-9]{8}|[a-f0-9]{12})_");

    private StorageClient() {}

    // ── Helpers JSON (baixo nível) ────────────────────────────────────────────

    /**
     * Lê blob JSON do GCS; retorna {@code defaultValue} se o blob não existir ou falhar.
     *
     * @param blobName   Caminho completo do blob (ex.: {@code historico/001.json}).
     * @param targetType Tipo Jackson para deserialização.
     * @param defaultValue Valor retornado em caso de ausência ou erro.
     * @param <T>        Tipo do objeto JSON esperado.
     * @return           Objeto deserializado ou {@code defaultValue}.
     */
    public static <T> T gcsReadJson(String blobName, TypeReference<T> targetType, T defaultValue) {
        try {
            Storage client = GcpAuth.storageClient();
            Blob blob = client.get(GcpAuth.bucketName(), blobName);
            if (blob == null || !blob.exists()) return defaultValue;
            String json = new String(blob.getContent(), StandardCharsets.UTF_8);
            return MAPPER.readValue(json, targetType);
        } catch (Exception e) {
            log.warn("Erro ao ler JSON do GCS '{}': {}", blobName, e.getMessage());
            return defaultValue;
        }
    }

    /**
     * Serializa {@code data} como JSON e salva no GCS sobrescrevendo o blob.
     *
     * @param blobName Caminho completo do blob no GCS.
     * @param data     Objeto a serializar e persistir.
     * @throws IOException se a serialização ou o upload falharem.
     */
    public static void gcsWriteJson(String blobName, Object data) throws IOException {
        Storage client = GcpAuth.storageClient();
        byte[] json = MAPPER.writerWithDefaultPrettyPrinter()
                .writeValueAsString(data)
                .getBytes(StandardCharsets.UTF_8);
        BlobId blobId = BlobId.of(GcpAuth.bucketName(), blobName);
        BlobInfo info = BlobInfo.newBuilder(blobId)
                .setContentType("application/json")
                .build();
        client.create(info, json);
    }

    // ── Helpers de nome e status ──────────────────────────────────────────────

    /**
     * Extrai o nome original do arquivo a partir do blob_name ou metadata.
     *
     * <p>Prioriza {@code metadata.nome_original}; caso contrário, remove o prefixo
     * de UUID/ID gerado automaticamente (ex.: {@code a3f1c9b2e012_relatorio.pdf}
     * → {@code relatorio.pdf}).
     *
     * @param blobName Nome do blob no GCS.
     * @param metadata Mapa de metadata do blob (pode ser null).
     * @return Nome limpo do arquivo.
     */
    public static String nomeDoBlobName(String blobName, Map<String, String> metadata) {
        if (metadata != null && metadata.containsKey("nome_original")) {
            return metadata.get("nome_original");
        }
        String raw = blobName.contains("/")
                ? blobName.substring(blobName.lastIndexOf('/') + 1)
                : blobName;
        return PREFIX_PATTERN.matcher(raw).replaceFirst("");
    }

    /**
     * Deriva status de indexação com base em metadata e janela de tempo desde o upload.
     *
     * @param blob    Blob do GCS já carregado.
     * @return Status: {@code "indexado"}, {@code "indexando"}, {@code "aguardando"} ou {@code "erro"}.
     */
    public static String statusIndexacaoBlob(Blob blob) {
        Map<String, String> metadata = blob.getMetadata() != null
                ? blob.getMetadata()
                : Collections.emptyMap();
        String statusMeta = metadata.getOrDefault("status_indexacao", "").trim().toLowerCase();
        OffsetDateTime created = blob.getCreateTimeOffsetDateTime();

        // Respeita o status explícito gravado no metadata, exceto "indexando" expirado.
        if (Set.of("erro", "indexado", "indexando", "aguardando").contains(statusMeta)) {
            if ("indexando".equals(statusMeta) && created != null) {
                long age = Duration.between(created, OffsetDateTime.now(ZoneOffset.UTC)).getSeconds();
                return age > INDEX_GRACE_SECONDS ? "erro" : "indexando";
            }
            return statusMeta;
        }

        // Sem metadata de status: infere pela janela de tempo.
        if (created != null) {
            long age = Duration.between(created, OffsetDateTime.now(ZoneOffset.UTC)).getSeconds();
            return age < INDEX_GRACE_SECONDS ? "indexando" : "indexado";
        }
        return "indexado";
    }

    /**
     * Retorna classe CSS correspondente ao status de indexação.
     *
     * @param status Status de indexação do documento.
     * @return Classe CSS: {@code "ok"}, {@code "info"} ou {@code "warn"}.
     */
    public static String statusCss(String status) {
        return switch (status) {
            case "indexado"   -> "ok";
            case "indexando",
                 "aguardando" -> "info";
            case "erro"       -> "warn";
            default           -> "ok";
        };
    }

    /**
     * Retorna label legível do status de indexação.
     *
     * @param status Status de indexação do documento.
     * @return Label exibível ao usuário.
     */
    public static String statusLabel(String status) {
        return switch (status) {
            case "indexado"   -> "Indexado";
            case "indexando"  -> "Indexando";
            case "aguardando" -> "Aguardando indexação";
            case "erro"       -> "Falha de indexação";
            default           -> "Indexado";
        };
    }

    // ── Listagem e contagem ───────────────────────────────────────────────────

    /**
     * Lista documentos lendo diretamente do Cloud Storage.
     *
     * <p>Retorna lista de mapas prontos para serialização JSON, ordenados por
     * data de upload decrescente. Exclui a categoria {@code legado}.
     *
     * @param categoria Filtro opcional de categoria (null = todas).
     * @return Lista de documentos com campos id, nome, tipo, categoria, status, etc.
     * @throws IOException se o cliente GCS não puder ser construído.
     */
    public static List<Map<String, String>> listarDocumentos(String categoria) throws IOException {
        GcpAuth.initVertex();
        Storage client = GcpAuth.storageClient();
        String prefix = (categoria != null && !categoria.isBlank())
                ? "documentos/" + categoria + "/"
                : "documentos/";

        List<Map<String, String>> docs = new ArrayList<>();

        Iterable<Blob> blobs = client.list(
                GcpAuth.bucketName(),
                Storage.BlobListOption.prefix(prefix)
        ).iterateAll();

        for (Blob blob : blobs) {
            String[] parts = blob.getName().split("/");
            // Estrutura esperada: documentos/{categoria}/{id_nome}
            if (parts.length < 3 || parts[1].isEmpty() || parts[2].isEmpty()) continue;

            String cat = parts[1];
            if ("legado".equals(cat)) continue; // Documentos arquivados não aparecem na listagem ativa.

            Map<String, String> meta = blob.getMetadata() != null
                    ? blob.getMetadata()
                    : Collections.emptyMap();
            String nome = nomeDoBlobName(blob.getName(), meta);
            String tipo = nome.contains(".")
                    ? nome.substring(nome.lastIndexOf('.') + 1).toLowerCase()
                    : "txt";
            String dataUpload = blob.getCreateTimeOffsetDateTime() != null
                    ? blob.getCreateTimeOffsetDateTime()
                            .format(DateTimeFormatter.ofPattern("yyyy-MM-dd HH:mm"))
                    : "";
            String status = statusIndexacaoBlob(blob);

            Map<String, String> doc = new LinkedHashMap<>();
            doc.put("id",              blob.getName());
            doc.put("nome",            nome);
            doc.put("tipo",            tipo);
            doc.put("categoria",       cat);
            doc.put("descricao",       meta.getOrDefault("descricao", ""));
            doc.put("data_upload",     dataUpload);
            doc.put("gcs_uri",         "gs://" + GcpAuth.bucketName() + "/" + blob.getName());
            doc.put("status_indexacao", status);
            doc.put("status_css",      statusCss(status));
            doc.put("status_label",    statusLabel(status));
            docs.add(doc);
        }

        // Ordena por data de upload decrescente.
        docs.sort(Comparator.comparing(d -> d.getOrDefault("data_upload", ""),
                Comparator.reverseOrder()));
        return docs;
    }

    /**
     * Conta todos os documentos ativos no Cloud Storage (exclui {@code legado/}).
     *
     * @return Contagem de documentos ativos.
     * @throws IOException se o cliente GCS não puder ser construído.
     */
    public static long contarDocumentos() throws IOException {
        GcpAuth.initVertex();
        Storage client = GcpAuth.storageClient();
        return StreamSupport.stream(
                client.list(GcpAuth.bucketName(),
                        Storage.BlobListOption.prefix("documentos/")).iterateAll().spliterator(),
                false)
                .filter(b -> {
                    String[] p = b.getName().split("/");
                    return p.length >= 3 && !p[2].isEmpty() && !"legado".equals(p[1]);
                })
                .count();
    }

    /**
     * Conta documentos de uma categoria específica no Cloud Storage.
     *
     * @param categoria Categoria a contar.
     * @return Contagem de documentos na categoria.
     * @throws IOException se o cliente GCS não puder ser construído.
     */
    public static long contarDocumentosCategoria(String categoria) throws IOException {
        GcpAuth.initVertex();
        Storage client = GcpAuth.storageClient();
        return StreamSupport.stream(
                client.list(GcpAuth.bucketName(),
                        Storage.BlobListOption.prefix("documentos/" + categoria + "/"))
                        .iterateAll().spliterator(),
                false)
                .filter(b -> {
                    String[] p = b.getName().split("/");
                    return p.length >= 3 && !p[2].isEmpty();
                })
                .count();
    }

    // ── Upload e remoção ──────────────────────────────────────────────────────

    /**
     * Faz upload do arquivo ao GCS e dispara a pipeline de ingestão.
     *
     * <p>Fluxo assíncrono (quando Cloud Tasks está configurado):
     * <ol>
     *   <li>Upload do arquivo RAW para o GCS.</li>
     *   <li>Enfileira uma tarefa HTTP para o worker no Cloud Run.</li>
     *   <li>Retorna imediatamente com status {@code "indexando"}.</li>
     * </ol>
     *
     * <p>Fluxo síncrono (fallback sem Cloud Tasks):
     * <ol>
     *   <li>Upload do arquivo RAW para o GCS.</li>
     *   <li>Importa diretamente no Agent Builder (aguarda até 5s).</li>
     *   <li>Retorna com status {@code "indexado"}, {@code "indexando"} ou {@code "erro"}.</li>
     * </ol>
     *
     * @param nome          Nome original do arquivo (sanitizado contra path traversal).
     * @param tipo          Extensão do arquivo (pdf, docx, txt).
     * @param categoria     Categoria de conhecimento no Data Store.
     * @param descricao     Descrição opcional do documento.
     * @param conteudoBytes Bytes do arquivo.
     * @param usuario       Matrícula ou identificador do usuário que fez o upload.
     * @return Mapa com {@code blob_name} e {@code status_indexacao}.
     * @throws IOException se o upload ao GCS falhar.
     */
    public static Map<String, String> salvarDocumento(
            String nome,
            String tipo,
            String categoria,
            String descricao,
            byte[] conteudoBytes,
            String usuario) throws IOException {

        GcpAuth.initVertex();

        // Sanitiza o nome para prevenir path traversal.
        nome = sanitizarNome(nome);

        String uid = UUID.randomUUID().toString().replace("-", "").substring(0, 12);
        String blobName = "documentos/" + categoria + "/" + uid + "_" + nome;
        String gcsUri   = "gs://" + GcpAuth.bucketName() + "/" + blobName;

        Storage client = GcpAuth.storageClient();
        BlobId blobId = BlobId.of(GcpAuth.bucketName(), blobName);
        Map<String, String> meta = new HashMap<>();
        meta.put("nome_original",    nome);
        meta.put("descricao",        descricao != null ? descricao : "");
        meta.put("usuario_upload",   usuario);
        meta.put("categoria",        categoria);
        meta.put("status_indexacao", "aguardando");
        meta.put("uploaded_at",      Instant.now().toString());

        BlobInfo info = BlobInfo.newBuilder(blobId)
                .setContentType(MIME_TYPES.getOrDefault(tipo.toLowerCase(), "application/octet-stream"))
                .setMetadata(meta)
                .build();
        client.create(info, conteudoBytes);

        // ── Tenta fluxo assíncrono via Cloud Tasks ────────────────────────────
        Map<String, Object> payload = new HashMap<>();
        payload.put("blob_name", blobName);
        payload.put("gcs_uri",   gcsUri);
        payload.put("nome",      nome);
        payload.put("categoria", categoria);
        payload.put("tipo",      tipo);
        payload.put("usuario",   usuario);

        boolean despachado = TasksClient.despacharTarefaProcessamento(payload);
        if (despachado) {
            return Map.of("blob_name", blobName, "status_indexacao", "indexando");
        }

        // ── Fallback síncrono: importa direto no Agent Builder ────────────────
        Blob blob = client.get(GcpAuth.bucketName(), blobName);
        String status = importarNoAgentBuilder(gcsUri, blob, 5);
        return Map.of("blob_name", blobName, "status_indexacao", status);
    }

    /**
     * Baixa e retorna os bytes de um blob do Cloud Storage.
     *
     * @param blobName Caminho do blob no GCS.
     * @return Bytes do blob.
     * @throws IOException se o blob não existir ou não puder ser baixado.
     */
    public static byte[] baixarBlob(String blobName) throws IOException {
        GcpAuth.initVertex();
        Blob blob = GcpAuth.storageClient().get(GcpAuth.bucketName(), blobName);
        if (blob == null) throw new IOException("Blob não encontrado: " + blobName);
        return blob.getContent();
    }

    /**
     * Salva texto extraído por OCR como arquivo .txt companheiro no GCS.
     *
     * <p>O arquivo é salvo em {@code documentos/{categoria}/{uuid8}_ocr_{nome_sem_ext}.txt}.
     * Seus metadados apontam para o PDF original, garantindo rastreabilidade.
     *
     * @param nomeBase            Nome base do arquivo original (com ou sem extensão).
     * @param categoria           Categoria do documento.
     * @param texto               Texto extraído pelo OCR.
     * @param blobNameOriginal    blob_name do PDF original (para rastreabilidade).
     * @return blob_name do arquivo .txt criado.
     * @throws IOException se o upload falhar.
     */
    public static String salvarTextoOcr(
            String nomeBase,
            String categoria,
            String texto,
            String blobNameOriginal) throws IOException {

        GcpAuth.initVertex();
        String nomeSemExt = nomeBase.contains(".")
                ? nomeBase.substring(0, nomeBase.lastIndexOf('.'))
                : nomeBase;
        String uid = UUID.randomUUID().toString().replace("-", "").substring(0, 8);
        String blobName = "documentos/" + categoria + "/" + uid + "_ocr_" + nomeSemExt + ".txt";

        Storage client = GcpAuth.storageClient();
        BlobId blobId = BlobId.of(GcpAuth.bucketName(), blobName);
        Map<String, String> meta = new HashMap<>();
        meta.put("nome_original",     "ocr_" + nomeSemExt + ".txt");
        meta.put("blob_pdf_original", blobNameOriginal);
        meta.put("categoria",         categoria);
        meta.put("status_indexacao",  "indexando");
        meta.put("uploaded_at",       Instant.now().toString());

        BlobInfo info = BlobInfo.newBuilder(blobId)
                .setContentType("text/plain")
                .setMetadata(meta)
                .build();
        client.create(info, texto.getBytes(StandardCharsets.UTF_8));
        log.info("Texto OCR salvo: {} ({} chars)", blobName, texto.length());
        return blobName;
    }

    /**
     * Importa um URI GCS no Agent Builder e atualiza o status do blob_name.
     *
     * <p>O blob_name pode diferir do URI importado — quando se indexa um .txt de OCR
     * mas se quer atualizar o status do PDF original.
     *
     * @param gcsUri      URI do GCS a ser importado no Agent Builder.
     * @param blobName    blob_name cujo metadata de status será atualizado.
     * @param waitTimeout Segundos para aguardar a LRO.
     * @return {@code "indexado"} (submissão aceita) ou {@code "erro"}.
     */
    public static String importarGcsParaVertex(String gcsUri, String blobName, int waitTimeout) {
        GcpAuth.initVertex();
        try {
            Storage client = GcpAuth.storageClient();
            Blob blob = client.get(GcpAuth.bucketName(), blobName);
            if (blob == null) throw new IOException("Blob não encontrado: " + blobName);
            blob.reload();
            return importarNoAgentBuilder(gcsUri, blob, waitTimeout);
        } catch (Exception e) {
            log.warn("Erro ao preparar importação para o Agent Builder '{}': {}", blobName, e.getMessage());
            return "erro";
        }
    }

    /**
     * Remove blob do Cloud Storage e deleta o documento correspondente no Agent Builder.
     *
     * @param blobName blob_name do documento a remover.
     * @throws IOException se o cliente GCS não puder ser construído.
     */
    public static void removerDocumento(String blobName) throws IOException {
        GcpAuth.initVertex();
        String bucketName = GcpAuth.bucketName();
        String gcsUri = "gs://" + bucketName + "/" + blobName;

        // 1. Remove do Cloud Storage.
        try {
            GcpAuth.storageClient().delete(BlobId.of(bucketName, blobName));
        } catch (Exception e) {
            log.warn("Erro ao deletar blob do GCS '{}': {}", blobName, e.getMessage());
        }

        // 2. Localiza e deleta do Agent Builder pelo URI do GCS.
        try (DocumentServiceClient deClient = DocumentServiceClient.create()) {
            String branch = String.format(
                    "projects/%s/locations/%s/collections/default_collection"
                            + "/dataStores/%s/branches/default_branch",
                    GcpAuth.projectId(), GcpAuth.searchLocation(), GcpAuth.dataStoreId());

            boolean removido = false;
            for (Document doc : deClient.listDocuments(branch).iterateAll()) {
                String docUri = extrairUriDoDocumento(doc);
                if (docUri.stripTrailing().equals(gcsUri.stripTrailing())) {
                    deClient.deleteDocument(doc.getName());
                    log.info("Documento removido do Agent Builder: {}", doc.getName());
                    removido = true;
                    break;
                }
            }
            if (!removido) {
                log.info("Documento não encontrado no Agent Builder para blob '{}'", blobName);
            }
        } catch (Exception e) {
            log.warn("Erro ao remover documento do Agent Builder '{}': {}", blobName, e.getMessage());
        }
    }

    /**
     * Move blob para {@code documentos/legado/}, preservando o arquivo para auditorias retroativas.
     *
     * <p>Fluxo:
     * <ol>
     *   <li>Copia o blob para {@code documentos/legado/{uuid8}_{nome_original}} com metadata.</li>
     *   <li>Deleta o blob original do GCS.</li>
     *   <li>Remove do Agent Builder (índice mantém apenas a versão ativa).</li>
     * </ol>
     *
     * @param blobName blob_name do documento a arquivar.
     * @return blob_name do arquivo arquivado (em legado/).
     * @throws IOException se o cliente GCS não puder ser construído.
     */
    public static String arquivarComoLegado(String blobName) throws IOException {
        GcpAuth.initVertex();
        String bucketName = GcpAuth.bucketName();
        Storage client = GcpAuth.storageClient();
        Blob sourceBlob = client.get(bucketName, blobName);
        if (sourceBlob == null) throw new IOException("Blob não encontrado: " + blobName);
        sourceBlob.reload();

        // Monta o caminho de destino: documentos/legado/{uuid8}_{nome_original}
        Map<String, String> sourceMeta = sourceBlob.getMetadata() != null
                ? sourceBlob.getMetadata()
                : Collections.emptyMap();
        String nomeOriginal = sourceMeta.containsKey("nome_original")
                ? sourceMeta.get("nome_original")
                : blobName.substring(blobName.lastIndexOf('/') + 1);
        String uid = UUID.randomUUID().toString().replace("-", "").substring(0, 8);
        String legadoBlobName = "documentos/legado/" + uid + "_" + nomeOriginal;

        // Copia para legado/ enriquecendo o metadata com dados de arquivamento.
        CopyWriter copyWriter = sourceBlob.copyTo(BlobId.of(bucketName, legadoBlobName));
        copyWriter.getResult();
        Blob legadoBlob = client.get(bucketName, legadoBlobName);
        legadoBlob.reload();

        Map<String, String> legadoMeta = new HashMap<>(
                legadoBlob.getMetadata() != null ? legadoBlob.getMetadata() : Collections.emptyMap());
        legadoMeta.put("status_indexacao", "legado");
        legadoMeta.put("arquivado_em",     Instant.now().toString());
        legadoMeta.put("blob_original",    blobName);
        legadoBlob.toBuilder().setMetadata(legadoMeta).build().update();
        log.info("Blob arquivado: {} → {}", blobName, legadoBlobName);

        // Remove o blob original do GCS.
        try {
            sourceBlob.delete();
        } catch (Exception e) {
            log.warn("Erro ao deletar blob original após arquivamento: {}", e.getMessage());
        }

        // Remove do Agent Builder — o índice usa somente a versão ativa.
        String gcsUri = "gs://" + bucketName + "/" + blobName;
        try (DocumentServiceClient deClient = DocumentServiceClient.create()) {
            String branch = String.format(
                    "projects/%s/locations/%s/collections/default_collection"
                            + "/dataStores/%s/branches/default_branch",
                    GcpAuth.projectId(), GcpAuth.searchLocation(), GcpAuth.dataStoreId());
            for (Document doc : deClient.listDocuments(branch).iterateAll()) {
                String docUri = extrairUriDoDocumento(doc);
                if (docUri.stripTrailing().equals(gcsUri.stripTrailing())) {
                    deClient.deleteDocument(doc.getName());
                    log.info("Versão anterior removida do Agent Builder: {}", doc.getName());
                    break;
                }
            }
        } catch (Exception e) {
            log.warn("Erro ao remover versão anterior do Agent Builder: {}", e.getMessage());
        }

        return legadoBlobName;
    }

    // ── Helpers privados ──────────────────────────────────────────────────────

    /**
     * Dispara import_documents no Agent Builder e atualiza o metadata de status no blob.
     *
     * <p>Aguarda até {@code waitTimeout} segundos pela LRO. Sem erro na API,
     * grava {@code "indexado"} no blob (submissão aceita). {@code "erro"} só se
     * {@code import_documents} falhar.
     */
    private static String importarNoAgentBuilder(String gcsUri, Blob blob, int waitTimeout) {
        try (DocumentServiceClient deClient = DocumentServiceClient.create()) {
            String parent = String.format(
                    "projects/%s/locations/%s/collections/default_collection"
                            + "/dataStores/%s/branches/default_branch",
                    GcpAuth.projectId(), GcpAuth.searchLocation(), GcpAuth.dataStoreId());

            ImportDocumentsRequest request = ImportDocumentsRequest.newBuilder()
                    .setParent(parent)
                    .setGcsSource(GcsSource.newBuilder()
                            .addInputUris(gcsUri)
                            .setDataSchema("content")
                            .build())
                    .setReconciliationMode(
                            ImportDocumentsRequest.ReconciliationMode.INCREMENTAL)
                    .build();

            // Aguarda até waitTimeout pela LRO. A API já aceitou a ingestão → marcamos indexado.
            try {
                deClient.importDocumentsAsync(request).get(waitTimeout, java.util.concurrent.TimeUnit.SECONDS);
            } catch (Exception ignored) {
                // Timeout esperado — a LRO pode continuar em background.
            }

            atualizarStatusBlob(blob, "indexado");
            return "indexado";
        } catch (Exception e) {
            log.warn("Erro ao disparar ingestão no Agent Builder: {}", e.getMessage());
            atualizarStatusBlob(blob, "erro");
            return "erro";
        }
    }

    /** Atualiza o campo status_indexacao no metadata do blob. */
    private static void atualizarStatusBlob(Blob blob, String status) {
        try {
            blob.reload();
            Map<String, String> meta = new HashMap<>(
                    blob.getMetadata() != null ? blob.getMetadata() : Collections.emptyMap());
            meta.put("status_indexacao", status);
            blob.toBuilder().setMetadata(meta).build().update();
        } catch (Exception e) {
            log.warn("Não foi possível atualizar status do blob: {}", e.getMessage());
        }
    }

    /** Extrai o URI GCS de um Document do Agent Builder (tenta content.uri, depois struct_data). */
    private static String extrairUriDoDocumento(Document doc) {
        if (doc.hasContent() && !doc.getContent().getUri().isEmpty()) {
            return doc.getContent().getUri();
        }
        // Fallback via struct_data (campo "link")
        if (doc.getStructData() != null) {
            var fields = doc.getStructData().getFieldsMap();
            if (fields.containsKey("link")) return fields.get("link").getStringValue();
        }
        return "";
    }

    /** Remove componentes de diretório do nome do arquivo (segurança contra path traversal). */
    private static String sanitizarNome(String nome) {
        if (nome == null || nome.isBlank()) return "arquivo";
        int sep = Math.max(nome.lastIndexOf('/'), nome.lastIndexOf('\\'));
        return sep >= 0 ? nome.substring(sep + 1) : nome;
    }
}
