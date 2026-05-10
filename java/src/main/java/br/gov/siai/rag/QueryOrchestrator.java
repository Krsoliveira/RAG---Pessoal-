package br.gov.siai.rag;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.util.List;
import java.util.Map;
import java.util.UUID;

/**
 * Camada de orquestração do fluxo retrieve → policy gate.
 *
 * <p>Responsabilidade: manter as views/handlers enxutos e centralizar a lógica
 * de recuperação de contexto e bloqueio de respostas.
 *
 * <p>Espelha: {@code ai_agents/services/query_orchestrator.py}
 *
 * <p>Depende de: {@link VertexSearch}
 */
public class QueryOrchestrator {

    private static final Logger log = LoggerFactory.getLogger(QueryOrchestrator.class);

    // ── Recuperação de contexto ───────────────────────────────────────────────

    /**
     * Busca contexto no Vertex AI Agent Builder e retorna métricas de qualidade.
     *
     * <p>Gera um {@code request_id} único por chamada para facilitar rastreabilidade
     * em logs distribuídos (Cloud Logging).
     *
     * @param pergunta  Texto da pergunta do auditor.
     * @param categoria Filtro de categoria (null = todas).
     * @param topK      Número máximo de documentos a retornar.
     * @return Mapa com {@code request_id}, {@code docs} e {@code score_medio}.
     */
    public Map<String, Object> retrieveContext(String pergunta, String categoria, int topK) {
        String requestId = UUID.randomUUID().toString().replace("-", "").substring(0, 12);

        List<Map<String, Object>> docs = VertexSearch.buscarContextoInteligente(
                pergunta, categoria, topK);

        double scoreMedio = docs.isEmpty() ? 0.0
                : Math.round(docs.stream()
                        .mapToDouble(d -> ((Number) d.getOrDefault("score", 0.0)).doubleValue())
                        .average()
                        .orElse(0.0) * 10_000.0) / 10_000.0;

        log.info("rag_retrieve request_id={} categoria={} docs={} score_medio={}",
                requestId, categoria != null ? categoria : "todas", docs.size(), scoreMedio);

        return Map.of(
                "request_id",   requestId,
                "docs",         docs,
                "score_medio",  scoreMedio);
    }

    // ── Policy gate ───────────────────────────────────────────────────────────

    /**
     * Bloqueia resposta apenas quando não há nenhum conteúdo recuperado.
     *
     * <p>O modelo Gemini decide se o conteúdo é suficiente para responder
     * com qualidade — o gate apenas verifica ausência total de contexto.
     *
     * @param docs     Lista de documentos recuperados pelo {@link #retrieveContext}.
     * @param pergunta Pergunta original (para customização futura da mensagem de bloqueio).
     * @return Array com {@code [bloqueado (boolean), mensagem (String)]}.
     *         Se {@code bloqueado = false}, {@code mensagem} é vazia.
     */
    public Object[] shouldBlockAnswer(List<Map<String, Object>> docs, String pergunta) {
        if (docs == null || docs.isEmpty()) {
            return new Object[]{
                true,
                "Não encontrei evidências suficientes na base para responder com segurança."
            };
        }

        String textoTotal = docs.stream()
                .map(d -> String.valueOf(d.getOrDefault("texto", "")))
                .reduce("", String::concat)
                .strip();

        if (textoTotal.isEmpty()) {
            return new Object[]{
                true,
                "Os trechos recuperados estavam vazios. "
                + "Refaça a pergunta ou aguarde a indexação completar."
            };
        }

        return new Object[]{false, ""};
    }
}
