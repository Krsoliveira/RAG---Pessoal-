package br.gov.siai.rag;

import com.google.cloud.discoveryengine.v1.*;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.util.*;
import java.util.regex.Pattern;
import java.util.stream.Collectors;

/**
 * Busca semântica via Vertex AI Agent Builder (Enterprise Search).
 *
 * <p>Responsabilidade: encapsular todo o protocolo do SearchServiceClient —
 * serving config, iteração do pager, extração de conteúdo e consolidação de
 * chunks por documento.
 *
 * <p>Espelha: {@code ai_agents/services/vertex_search.py}
 *
 * <p>Depende de: {@link GcpAuth}
 */
public final class VertexSearch {

    private static final Logger log = LoggerFactory.getLogger(VertexSearch.class);

    // Regex para limpar prefixo gs://bucket/documentos/{categoria}/ e UUID do nome.
    private static final Pattern GCS_PREFIX_PATTERN =
            Pattern.compile("^gs://[^/]+/documentos/[^/]+/");
    private static final Pattern UUID_PREFIX_PATTERN =
            Pattern.compile("^(?:\\d+|[a-f0-9]{12})_");

    // Tags HTML a remover do texto extraído.
    private static final Pattern HTML_TAG_PATTERN = Pattern.compile("<[^<]+>");

    private VertexSearch() {}

    /**
     * Retorna trechos relevantes via Vertex AI Agent Builder Search.
     *
     * <p>Estratégia de extração de texto (em ordem de prioridade):
     * <ol>
     *   <li>{@code extractive_segments} — trechos longos do documento, ideais para RAG.</li>
     *   <li>{@code extractive_answers}  — resposta direta à query (Enterprise Edition).</li>
     *   <li>{@code snippets}            — fallback quando os anteriores não retornam conteúdo.</li>
     * </ol>
     *
     * @param pergunta  Texto da pergunta ou consulta.
     * @param categoria Filtro opcional de categoria (null = todas).
     * @param topK      Número máximo de resultados a retornar.
     * @return Lista de mapas com chaves: {@code nome}, {@code uri}, {@code texto}, {@code score}.
     */
    public static List<Map<String, Object>> buscarContextoInteligente(
            String pergunta,
            String categoria,
            int topK) {

        GcpAuth.initVertex();

        try {
            String project       = GcpAuth.projectId();
            String location      = GcpAuth.searchLocation();
            String servingConfig = GcpAuth.servingConfig(project, location);

            // Configura o spec de conteúdo para extractive segments e answers.
            SearchRequest.ContentSearchSpec contentSpec =
                    SearchRequest.ContentSearchSpec.newBuilder()
                            .setSnippetSpec(
                                    SearchRequest.ContentSearchSpec.SnippetSpec.newBuilder()
                                            .setReturnSnippet(true)
                                            .setMaxSnippetCount(5)
                                            .build())
                            .setExtractiveContentSpec(
                                    SearchRequest.ContentSearchSpec.ExtractiveContentSpec.newBuilder()
                                            .setMaxExtractiveAnswerCount(2)
                                            .setMaxExtractiveSegmentCount(5)
                                            .build())
                            .build();

            SearchRequest request = SearchRequest.newBuilder()
                    .setServingConfig(servingConfig)
                    .setQuery(pergunta)
                    .setPageSize(topK)
                    .setContentSearchSpec(contentSpec)
                    .build();

            SearchServiceClient client = SearchServiceClient.create();
            // IMPORTANTE: iterar o pager diretamente (não .getResults()) — o pager
            // precisa ser consumido para que os resultados sejam retornados.
            List<SearchResponse.SearchResult> results = new ArrayList<>();
            for (SearchResponse.SearchResult result : client.search(request).iterateAll()) {
                results.add(result);
            }
            client.close();

            log.info("Agent Builder search: {} resultado(s) | serving_config={} | query='{}'  | categoria={}",
                    results.size(), servingConfig,
                    pergunta.length() > 60 ? pergunta.substring(0, 60) : pergunta,
                    categoria != null ? categoria : "todas");

            List<Map<String, Object>> chunks = extrairChunks(results);
            log.info("Chunks extraídos: {} | categoria={}", chunks.size(),
                    categoria != null ? categoria : "todas");

            // Filtra por categoria verificando o URI do blob.
            if (categoria != null && !categoria.isBlank()) {
                final String cat = categoria;
                chunks = chunks.stream()
                        .filter(c -> ((String) c.getOrDefault("uri", ""))
                                .toLowerCase().contains("/" + cat + "/"))
                        .collect(Collectors.toList());
            }

            return consolidarChunks(chunks, topK);

        } catch (Exception e) {
            log.warn("Erro no Vertex AI Search: {}", e.getMessage());
            return Collections.emptyList();
        }
    }

    // ── Extração de chunks ────────────────────────────────────────────────────

    /**
     * Percorre os resultados do Agent Builder e extrai chunks de texto.
     *
     * @param results Lista de resultados do Agent Builder Search.
     * @return Lista de chunks com chaves: nome, uri, texto, score.
     */
    static List<Map<String, Object>> extrairChunks(
            List<SearchResponse.SearchResult> results) {

        List<Map<String, Object>> chunks = new ArrayList<>();

        for (SearchResponse.SearchResult result : results) {
            Document doc = result.getDocument();

            // derivedStructData contém campos proto — converte para Map.
            Map<String, com.google.protobuf.Value> dsd = Collections.emptyMap();
            if (doc.hasDerivedStructData()) {
                dsd = doc.getDerivedStructData().getFieldsMap();
            }

            String docName = getStringField(dsd, "title");
            if (docName.isEmpty()) docName = doc.getId().isEmpty() ? "Documento" : doc.getId();

            double score = result.hasModelScores()
                    ? result.getModelScoresMap().values().stream()
                            .mapToDouble(ms -> ms.getValues(0))
                            .average().orElse(0.0)
                    : 0.0;

            List<String> textos = extrairTextos(dsd, docName);
            String gcsUri = getStringField(dsd, "link");

            // Remove prefixo gs://bucket/documentos/{categoria}/ e UUID do nome.
            String nomeLimpo = GCS_PREFIX_PATTERN.matcher(docName).replaceFirst("");
            nomeLimpo = UUID_PREFIX_PATTERN.matcher(nomeLimpo).replaceFirst("");

            for (String texto : textos) {
                String textoLimpo = HTML_TAG_PATTERN.matcher(texto).replaceAll("").strip();
                if (!textoLimpo.isEmpty()) {
                    Map<String, Object> chunk = new HashMap<>();
                    chunk.put("nome",  nomeLimpo.isEmpty() ? docName : nomeLimpo);
                    chunk.put("uri",   gcsUri);
                    chunk.put("texto", textoLimpo);
                    chunk.put("score", score);
                    chunks.add(chunk);
                }
            }
        }

        return chunks;
    }

    /**
     * Extrai lista de textos de um resultado, seguindo a hierarquia de prioridade.
     *
     * <p>Ordem: extractive_segments → extractive_answers → snippets.
     *
     * @param dsd     Mapa de campos do derivedStructData.
     * @param docName Nome do documento (para log de depuração).
     * @return Lista de textos extraídos (pode estar vazia).
     */
    private static List<String> extrairTextos(
            Map<String, com.google.protobuf.Value> dsd,
            String docName) {

        List<String> textos = new ArrayList<>();

        // 1. extractive_segments — trechos longos, melhor para RAG.
        if (dsd.containsKey("extractive_segments")) {
            List<com.google.protobuf.Value> segments =
                    dsd.get("extractive_segments").getListValue().getValuesList();
            for (int i = 0; i < Math.min(3, segments.size()); i++) {
                String content = getStringFromValue(segments.get(i), "content");
                if (!content.isEmpty()) textos.add(content);
            }
        }

        // 2. extractive_answers — resposta direta à query.
        if (textos.isEmpty() && dsd.containsKey("extractive_answers")) {
            List<com.google.protobuf.Value> answers =
                    dsd.get("extractive_answers").getListValue().getValuesList();
            for (int i = 0; i < Math.min(2, answers.size()); i++) {
                String content = getStringFromValue(answers.get(i), "content");
                if (!content.isEmpty()) textos.add(content);
            }
        }

        // 3. snippets — fallback mínimo.
        if (textos.isEmpty() && dsd.containsKey("snippets")) {
            List<com.google.protobuf.Value> snippets =
                    dsd.get("snippets").getListValue().getValuesList();
            for (int i = 0; i < Math.min(3, snippets.size()); i++) {
                String content = getStringFromValue(snippets.get(i), "snippet");
                if (!content.isEmpty()) textos.add(content);
            }
        }

        if (textos.isEmpty()) {
            log.debug("Resultado sem texto extraível | doc={} | dsd_keys={}", docName, dsd.keySet());
        }

        return textos;
    }

    // ── Consolidação de chunks ────────────────────────────────────────────────

    /**
     * Agrupa chunks pelo URI do documento e retorna os mais relevantes.
     *
     * <p>Para cada documento, mantém no máximo 2 trechos únicos (maior score primeiro).
     * Isso melhora a cobertura factual sem repetir conteúdo do mesmo arquivo.
     *
     * @param chunks Lista de chunks extraídos.
     * @param topK   Número máximo de documentos consolidados a retornar.
     * @return Lista consolidada ordenada por score decrescente.
     */
    public static List<Map<String, Object>> consolidarChunks(
            List<Map<String, Object>> chunks, int topK) {

        // Agrupa chunks por URI (ou nome, se URI vazio).
        Map<String, List<Map<String, Object>>> byUri = new LinkedHashMap<>();
        for (Map<String, Object> chunk : chunks) {
            String key = (String) chunk.getOrDefault("uri",
                    chunk.getOrDefault("nome", "unknown"));
            if (key.isEmpty()) key = (String) chunk.getOrDefault("nome", "unknown");
            byUri.computeIfAbsent(key, k -> new ArrayList<>()).add(chunk);
        }

        List<Map<String, Object>> consolidados = new ArrayList<>();
        for (List<Map<String, Object>> grouped : byUri.values()) {
            // Ordena por score decrescente dentro do grupo.
            grouped.sort(Comparator.comparingDouble(
                    c -> -((Number) c.getOrDefault("score", 0.0)).doubleValue()));

            // Mantém no máximo 2 trechos únicos por documento.
            List<String> topTrechos = new ArrayList<>();
            for (Map<String, Object> item : grouped) {
                String texto = ((String) item.getOrDefault("texto", "")).strip();
                if (!texto.isEmpty() && !topTrechos.contains(texto)) {
                    topTrechos.add(texto);
                }
                if (topTrechos.size() >= 2) break;
            }

            if (topTrechos.isEmpty()) continue;

            Map<String, Object> principal = grouped.get(0);
            Map<String, Object> consolidado = new HashMap<>();
            consolidado.put("nome",  principal.getOrDefault("nome", "Documento"));
            consolidado.put("uri",   principal.getOrDefault("uri", ""));
            consolidado.put("texto", String.join("\n\n", topTrechos));
            consolidado.put("score", principal.getOrDefault("score", 0.0));
            consolidados.add(consolidado);
        }

        // Ordena consolidados por score decrescente e limita ao topK.
        consolidados.sort(Comparator.comparingDouble(
                c -> -((Number) c.getOrDefault("score", 0.0)).doubleValue()));
        return consolidados.subList(0, Math.min(topK, consolidados.size()));
    }

    // ── Helpers proto ─────────────────────────────────────────────────────────

    /** Lê um campo string de um mapa de proto Values. */
    private static String getStringField(
            Map<String, com.google.protobuf.Value> fields, String key) {
        if (!fields.containsKey(key)) return "";
        return fields.get(key).getStringValue();
    }

    /** Lê um campo string de dentro de um Value que contém um StructValue (dicionário aninhado). */
    private static String getStringFromValue(com.google.protobuf.Value value, String key) {
        if (!value.hasStructValue()) return "";
        Map<String, com.google.protobuf.Value> inner = value.getStructValue().getFieldsMap();
        if (!inner.containsKey(key)) return "";
        return inner.get(key).getStringValue();
    }
}
