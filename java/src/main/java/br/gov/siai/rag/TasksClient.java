package br.gov.siai.rag;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.google.cloud.tasks.v2.*;
import com.google.protobuf.ByteString;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.io.IOException;
import java.time.Instant;
import java.util.HashMap;
import java.util.Map;

/**
 * Despacho de ingestão assíncrona via Google Cloud Tasks.
 *
 * <p>Responsabilidade: enfileirar chamadas HTTP autenticadas (OIDC) para o endpoint
 * worker do Django no Cloud Run, enviando payload JSON puro.
 *
 * <p>Espelha: {@code ai_agents/services/tasks_client.py}
 *
 * <p>Configuração via variáveis de ambiente:
 * <ul>
 *   <li>{@code RAG_INGEST_TASKS_QUEUE}                   — nome da fila Cloud Tasks</li>
 *   <li>{@code RAG_INGEST_TASKS_LOCATION}                — região da fila (ex.: us-central1)</li>
 *   <li>{@code RAG_INGEST_WORKER_URL}                    — URL do endpoint worker (Cloud Run)</li>
 *   <li>{@code RAG_INGEST_TASKS_SERVICE_ACCOUNT_EMAIL}   — SA para OIDC token</li>
 * </ul>
 */
public final class TasksClient {

    private static final Logger log = LoggerFactory.getLogger(TasksClient.class);
    private static final ObjectMapper MAPPER = new ObjectMapper();

    private TasksClient() {}

    /**
     * Cria uma tarefa HTTP no Cloud Tasks para processar um documento.
     *
     * <p>A tarefa autentica o worker via token OIDC gerado pela conta de serviço
     * configurada em {@code RAG_INGEST_TASKS_SERVICE_ACCOUNT_EMAIL}.
     *
     * <p>Retorna {@code false} sem logar erro se {@code RAG_INGEST_WORKER_URL} não
     * estiver configurado — comportamento esperado em desenvolvimento local.
     *
     * @param dadosDocumento Mapa com campos: blob_name, gcs_uri, nome, categoria, tipo, usuario.
     * @return {@code true} se a tarefa foi criada com sucesso; {@code false} caso contrário.
     */
    public static boolean despacharTarefaProcessamento(Map<String, Object> dadosDocumento) {
        String queueName           = getEnv("RAG_INGEST_TASKS_QUEUE");
        String location            = getEnv("RAG_INGEST_TASKS_LOCATION");
        String workerUrl           = getEnv("RAG_INGEST_WORKER_URL");
        String serviceAccountEmail = getEnv("RAG_INGEST_TASKS_SERVICE_ACCOUNT_EMAIL");

        // Sem URL do worker: ingestão síncrona em dev/local (comportamento esperado).
        if (workerUrl.isEmpty()) {
            log.debug("RAG_INGEST_WORKER_URL vazio — Cloud Tasks desligado; fallback síncrono. "
                    + "Em produção Cloud Run defina esta variável.");
            return false;
        }

        if (queueName.isEmpty() || location.isEmpty() || serviceAccountEmail.isEmpty()) {
            log.warn("Cloud Tasks incompleta: com worker_url definido, faltam fila/região/SA. "
                    + "queue={} location={} sa={}", !queueName.isEmpty(), !location.isEmpty(),
                    !serviceAccountEmail.isEmpty());
            return false;
        }

        // Enriquece o payload com a data de publicação.
        Map<String, Object> payload = new HashMap<>(dadosDocumento);
        payload.putIfAbsent("publicado_em", Instant.now().toString());

        try {
            GcpAuth.initVertex();
            byte[] payloadJson = MAPPER.writeValueAsBytes(payload);

            try (com.google.cloud.tasks.v2.CloudTasksClient client =
                         com.google.cloud.tasks.v2.CloudTasksClient.create()) {

                String parent = client.queuePath(GcpAuth.projectId(), location, queueName);

                Task task = Task.newBuilder()
                        .setHttpRequest(HttpRequest.newBuilder()
                                .setHttpMethod(HttpMethod.POST)
                                .setUrl(workerUrl)
                                .putHeaders("Content-Type", "application/json")
                                .setBody(ByteString.copyFrom(payloadJson))
                                .setOidcToken(OidcToken.newBuilder()
                                        .setServiceAccountEmail(serviceAccountEmail)
                                        .setAudience(workerUrl)
                                        .build())
                                .build())
                        .build();

                Task created = client.createTask(parent, task);
                log.info("Tarefa de ingestão criada no Cloud Tasks: {}", created.getName());
                return true;
            }
        } catch (Exception e) {
            log.error("Erro ao criar tarefa no Cloud Tasks: {}", e.getMessage(), e);
            return false;
        }
    }

    /** Lê variável de ambiente; retorna string vazia se não configurada. */
    private static String getEnv(String key) {
        String v = System.getenv(key);
        return (v != null) ? v.strip() : "";
    }
}
