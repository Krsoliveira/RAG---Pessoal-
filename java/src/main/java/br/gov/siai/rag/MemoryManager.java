package br.gov.siai.rag;

import com.fasterxml.jackson.core.type.TypeReference;
import com.google.cloud.vertexai.VertexAI;
import com.google.cloud.vertexai.generativeai.GenerativeModel;
import com.google.cloud.vertexai.api.GenerateContentResponse;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.io.IOException;
import java.time.Instant;
import java.util.*;

/**
 * Histórico de conversas e memória persistente do auditor.
 *
 * <p>Responsabilidade: manter o estado por usuário no Cloud Storage — histórico de
 * trocas em JSON (rolling window de 200) e perfil do auditor gerado pelo Gemini
 * Flash a cada 5 consultas.
 *
 * <p>Espelha: {@code ai_agents/services/memory_manager.py}
 *
 * <p>Depende de: {@link GcpAuth}, {@link StorageClient}
 */
public final class MemoryManager {

    private static final Logger log = LoggerFactory.getLogger(MemoryManager.class);

    // Tamanho máximo do histórico (rolling window).
    private static final int HISTORICO_MAX_SIZE = 200;

    // Modelo Gemini Flash para sumarização (deve estar disponível no projeto GCP).
    private static final String FLASH_MODEL =
            System.getenv().getOrDefault("GCP_VERTEX_GEMINI_FLASH_MODEL", "gemini-2.5-flash");

    // Localização do Vertex AI para chamadas de geração (ex.: us-central1).
    private static final String VERTEX_LOCATION =
            System.getenv().getOrDefault("GCP_VERTEX_LOCATION", "us-central1");

    private MemoryManager() {}

    // ── Histórico de conversas ────────────────────────────────────────────────

    /**
     * Persiste uma troca no histórico do usuário em GCS.
     *
     * <p>Mantém rolling window das últimas {@code HISTORICO_MAX_SIZE} trocas
     * para controlar o tamanho do blob.
     *
     * @param usuarioMatricula Matrícula ou ID único do usuário.
     * @param pergunta         Pergunta feita pelo auditor.
     * @param resposta         Resposta gerada pelo agente.
     * @param documentosUsados Lista de nomes/URIs dos documentos usados na resposta.
     * @throws IOException se a leitura ou escrita no GCS falhar.
     */
    public static void salvarHistorico(
            String usuarioMatricula,
            String pergunta,
            String resposta,
            List<String> documentosUsados) throws IOException {

        String blobName = "historico/" + usuarioMatricula + ".json";
        List<Map<String, Object>> historico = StorageClient.gcsReadJson(
                blobName,
                new TypeReference<List<Map<String, Object>>>() {},
                new ArrayList<>());

        Map<String, Object> troca = new LinkedHashMap<>();
        troca.put("pergunta",          pergunta);
        troca.put("resposta",          resposta);
        troca.put("documentos_usados", documentosUsados);
        troca.put("data_consulta",     Instant.now().toString());
        historico.add(troca);

        // Mantém rolling window das últimas HISTORICO_MAX_SIZE trocas.
        if (historico.size() > HISTORICO_MAX_SIZE) {
            historico = historico.subList(historico.size() - HISTORICO_MAX_SIZE, historico.size());
        }

        StorageClient.gcsWriteJson(blobName, historico);
    }

    /**
     * Retorna as últimas N trocas do usuário em ordem cronológica (mais antigas primeiro).
     *
     * @param usuarioMatricula Matrícula ou ID único do usuário.
     * @param n                Número de trocas recentes a retornar.
     * @return Lista de mapas com chaves {@code pergunta} e {@code resposta}.
     */
    public static List<Map<String, String>> buscarHistoricoRecente(
            String usuarioMatricula, int n) {

        String blobName = "historico/" + usuarioMatricula + ".json";
        List<Map<String, Object>> historico = StorageClient.gcsReadJson(
                blobName,
                new TypeReference<List<Map<String, Object>>>() {},
                new ArrayList<>());

        int start = Math.max(0, historico.size() - n);
        List<Map<String, Object>> recentes = historico.subList(start, historico.size());

        List<Map<String, String>> resultado = new ArrayList<>();
        for (Map<String, Object> h : recentes) {
            Map<String, String> troca = new LinkedHashMap<>();
            troca.put("pergunta", String.valueOf(h.getOrDefault("pergunta", "")));
            troca.put("resposta", String.valueOf(h.getOrDefault("resposta", "")));
            resultado.add(troca);
        }
        return resultado;
    }

    // ── Memória persistente (perfil do auditor) ───────────────────────────────

    /**
     * Retorna o perfil de consultas persistido do auditor (texto livre).
     *
     * <p>Gerado pelo Gemini Flash e atualizado a cada 5 consultas.
     * Retorna string vazia se ainda não foi gerado.
     *
     * @param usuarioMatricula Matrícula ou ID único do usuário.
     * @return Perfil do auditor como texto, ou string vazia.
     */
    public static String buscarMemoriaUsuario(String usuarioMatricula) {
        String blobName = "memoria/" + usuarioMatricula + ".json";
        Map<String, Object> data = StorageClient.gcsReadJson(
                blobName,
                new TypeReference<Map<String, Object>>() {},
                new HashMap<>());
        return String.valueOf(data.getOrDefault("resumo", ""));
    }

    /**
     * Atualiza a memória persistente do auditor via Gemini Flash (Vertex AI).
     *
     * <p>Executa apenas a cada 5 consultas para não adicionar latência em toda
     * interação. Sempre incrementa o contador {@code total_consultas}.
     *
     * @param usuarioMatricula Matrícula ou ID único do usuário.
     * @throws IOException se a leitura ou escrita no GCS falhar.
     */
    public static void atualizarMemoriaUsuario(String usuarioMatricula) throws IOException {
        String blobName = "memoria/" + usuarioMatricula + ".json";
        Map<String, Object> memoria = StorageClient.gcsReadJson(
                blobName,
                new TypeReference<Map<String, Object>>() {},
                new HashMap<>());

        int total = ((Number) memoria.getOrDefault("total_consultas", 0)).intValue() + 1;
        memoria.put("total_consultas", total);

        // Atualiza o perfil somente a cada 5 consultas.
        if (total % 5 == 0) {
            regenerarPerfil(usuarioMatricula, memoria);
        }

        StorageClient.gcsWriteJson(blobName, memoria);
    }

    // ── Privados ──────────────────────────────────────────────────────────────

    /**
     * Lê o histórico recente e pede ao Gemini Flash para gerar um perfil conciso.
     *
     * <p>O perfil é gravado em {@code memoria.resumo} e persistido pelo caller.
     *
     * @param usuarioMatricula Matrícula ou ID único do usuário.
     * @param memoria          Mapa de memória a ser atualizado in-place.
     */
    private static void regenerarPerfil(String usuarioMatricula, Map<String, Object> memoria) {
        List<Map<String, Object>> historico = StorageClient.gcsReadJson(
                "historico/" + usuarioMatricula + ".json",
                new TypeReference<List<Map<String, Object>>>() {},
                new ArrayList<>());

        if (historico.isEmpty()) return;

        // Monta trecho com as últimas 30 trocas.
        int start = Math.max(0, historico.size() - 30);
        StringBuilder trecho = new StringBuilder();
        for (Map<String, Object> h : historico.subList(start, historico.size())) {
            String pergunta = String.valueOf(h.getOrDefault("pergunta", ""));
            String resposta = String.valueOf(h.getOrDefault("resposta", ""));
            // Limita a 400 chars na resposta para não ultrapassar o contexto.
            if (resposta.length() > 400) resposta = resposta.substring(0, 400);
            trecho.append("Auditor: ").append(pergunta).append("\n");
            trecho.append("Agente: ").append(resposta).append("\n\n");
        }

        String prompt =
                "Analise o histórico de consultas deste auditor e gere um perfil conciso (máx. 200 palavras).\n"
                + "Inclua: principais normas/temas consultados, foco de auditoria, padrões de análise recorrentes.\n"
                + "Este perfil será injetado no system prompt — seja objetivo e direto.\n\n"
                + trecho;

        try {
            GcpAuth.initVertex();
            // CRÍTICO: usar vertexai SDK (conta de serviço), não Developer API (GOOGLE_API_KEY).
            // SDK: com.google.cloud:google-cloud-vertexai
            try (VertexAI vertexAI = new VertexAI(GcpAuth.projectId(), VERTEX_LOCATION)) {
                GenerativeModel model = new GenerativeModel(FLASH_MODEL, vertexAI);
                GenerateContentResponse response = model.generateContent(prompt);
                String resumo = response.getCandidates(0)
                        .getContent()
                        .getParts(0)
                        .getText();
                memoria.put("resumo",       resumo != null ? resumo : "");
                memoria.put("atualizado_em", Instant.now().toString());
            }
        } catch (Exception e) {
            log.warn("Erro ao atualizar memória do usuário '{}': {}", usuarioMatricula, e.getMessage());
        }
    }
}
