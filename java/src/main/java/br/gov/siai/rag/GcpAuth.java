package br.gov.siai.rag;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.google.auth.oauth2.GoogleCredentials;
import com.google.auth.oauth2.ServiceAccountCredentials;
import com.google.cloud.storage.Storage;
import com.google.cloud.storage.StorageOptions;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.io.FileInputStream;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Collections;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * Camada de autenticação e configuração GCP.
 *
 * <p>Responsabilidade única: resolver credenciais e construir clientes GCP.
 * Todos os outros módulos de serviço importam daqui — nunca o contrário.
 *
 * <p>Espelha: {@code ai_agents/services/gcp_auth.py}
 *
 * <p>Hierarquia de dependência:
 * <pre>
 *   GcpAuth  ←  StorageClient  ←  MemoryManager
 *   GcpAuth  ←  VertexSearch
 * </pre>
 *
 * <p>Configuração via variáveis de ambiente:
 * <ul>
 *   <li>{@code GCP_VERTEX_CREDENTIALS_PATH} — caminho do JSON de conta de serviço</li>
 *   <li>{@code BASE_DIR} — raiz do projeto (fallback para o caminho padrão de credenciais)</li>
 *   <li>{@code GCP_STORAGE_BUCKET} — nome do bucket GCS</li>
 *   <li>{@code GCP_VERTEX_DATA_STORE_ID} — ID do Data Store do Agent Builder</li>
 *   <li>{@code GCP_VERTEX_SEARCH_LOCATION} — localização do Vertex AI Search (padrão: global)</li>
 *   <li>{@code GCP_VERTEX_ENGINE_ID} — Engine ID do Search App Enterprise (opcional)</li>
 * </ul>
 */
public final class GcpAuth {

    private static final Logger log = LoggerFactory.getLogger(GcpAuth.class);
    private static final AtomicBoolean VERTEX_INIT_DONE = new AtomicBoolean(false);
    private static final ObjectMapper MAPPER = new ObjectMapper();

    // Escopo OAuth necessário para todas as APIs GCP usadas pelo RAG.
    private static final String GCP_SCOPE = "https://www.googleapis.com/auth/cloud-platform";

    private GcpAuth() {
        // Classe utilitária — sem instanciação.
    }

    // ── Credenciais e projeto ─────────────────────────────────────────────────

    /**
     * Resolve o caminho do JSON da conta de serviço RAG (sa-rag-api).
     *
     * <p>Prioridade: {@code GCP_VERTEX_CREDENTIALS_PATH} →
     * {@code $BASE_DIR/config/credentials_rag.json}
     */
    public static Path credentialsPath() {
        String raw = System.getenv("GCP_VERTEX_CREDENTIALS_PATH");
        if (raw != null && !raw.isBlank()) {
            return Path.of(raw.strip());
        }
        String baseDir = System.getenv().getOrDefault("BASE_DIR", ".");
        return Path.of(baseDir, "config", "credentials_rag.json");
    }

    /**
     * Lê o {@code project_id} diretamente do arquivo JSON da conta de serviço.
     *
     * @throws IOException  se o arquivo não puder ser lido.
     * @throws IllegalStateException se o campo {@code project_id} estiver ausente.
     */
    public static String projectId() throws IOException {
        JsonNode node = MAPPER.readTree(Files.readString(credentialsPath()));
        String pid = node.path("project_id").asText(null);
        if (pid == null || pid.isBlank()) {
            throw new IllegalStateException(
                    "Arquivo de credenciais GCP sem campo 'project_id'.");
        }
        return pid;
    }

    /**
     * Cria {@link GoogleCredentials} a partir do arquivo JSON da conta de serviço.
     *
     * @throws IOException se o arquivo de credenciais não puder ser lido.
     */
    public static GoogleCredentials credentials() throws IOException {
        return ServiceAccountCredentials
                .fromStream(new FileInputStream(credentialsPath().toFile()))
                .createScoped(Collections.singleton(GCP_SCOPE));
    }

    /**
     * Seta {@code GOOGLE_APPLICATION_CREDENTIALS} no ambiente (idempotente).
     *
     * <p>Todos os clientes GCP (Storage, Discovery Engine, Vertex AI) usam essa
     * variável automaticamente — não é necessário passar {@code credentials=} em cada um.
     * Equivalente a {@code _init_vertex()} no Python.
     */
    public static void initVertex() {
        if (VERTEX_INIT_DONE.compareAndSet(false, true)) {
            System.setProperty("GOOGLE_APPLICATION_CREDENTIALS",
                    credentialsPath().toAbsolutePath().toString());
            log.debug("GOOGLE_APPLICATION_CREDENTIALS configurado: {}", credentialsPath());
        }
    }

    // ── Cloud Storage — cliente e bucket ─────────────────────────────────────

    /**
     * Retorna o nome do bucket GCS configurado em {@code GCP_STORAGE_BUCKET}.
     *
     * @throws IllegalStateException se a variável não estiver configurada.
     */
    public static String bucketName() {
        String bucket = System.getenv("GCP_STORAGE_BUCKET");
        if (bucket == null || bucket.isBlank()) {
            throw new IllegalStateException(
                    "GCP_STORAGE_BUCKET não configurado nas variáveis de ambiente.");
        }
        return bucket.strip();
    }

    /**
     * Retorna cliente {@link Storage} autenticado com a conta de serviço.
     *
     * @throws IOException se as credenciais não puderem ser carregadas.
     */
    public static Storage storageClient() throws IOException {
        return StorageOptions.newBuilder()
                .setCredentials(credentials())
                .setProjectId(projectId())
                .build()
                .getService();
    }

    // ── Vertex AI Agent Builder — configuração de busca ──────────────────────

    /**
     * Retorna o ID do Data Store do Agent Builder.
     * Padrão: {@code banco-comigo-auditoria_1777308243982}.
     */
    public static String dataStoreId() {
        return System.getenv().getOrDefault(
                "GCP_VERTEX_DATA_STORE_ID",
                "banco-comigo-auditoria_1777308243982");
    }

    /**
     * Retorna a localização do Vertex AI Search.
     * Padrão: {@code global}.
     */
    public static String searchLocation() {
        return System.getenv().getOrDefault("GCP_VERTEX_SEARCH_LOCATION", "global");
    }

    /**
     * Retorna o Engine ID do Search App Enterprise.
     *
     * <p>Vazio significa que a busca usará o Data Store diretamente (modo Standard,
     * sem suporte a extractive content).
     */
    public static String engineId() {
        String v = System.getenv("GCP_VERTEX_ENGINE_ID");
        return (v != null) ? v.strip() : "";
    }

    /**
     * Monta o resource path completo do serving config para o SearchServiceClient.
     *
     * <ul>
     *   <li>Com Engine ID (Enterprise): suporta {@code extractive_segments} e
     *       {@code extractive_answers}.</li>
     *   <li>Sem Engine ID (Standard): retorna apenas snippets.</li>
     * </ul>
     *
     * @param project  ID do projeto GCP.
     * @param location Localização do Vertex AI Search (ex.: {@code global}).
     * @return path completo do serving config.
     */
    public static String servingConfig(String project, String location) {
        String eid = engineId();
        if (!eid.isEmpty()) {
            return String.format(
                    "projects/%s/locations/%s/collections/default_collection"
                            + "/engines/%s/servingConfigs/default_config",
                    project, location, eid);
        }
        return String.format(
                "projects/%s/locations/%s/collections/default_collection"
                        + "/dataStores/%s/servingConfigs/default_config",
                project, location, dataStoreId());
    }
}
