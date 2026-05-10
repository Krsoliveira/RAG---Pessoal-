package br.gov.siai.rag;

import java.util.List;
import java.util.Map;

/**
 * Ponto de entrada para demonstração do RAG GCP em Java.
 *
 * Antes de rodar, configure as variáveis de ambiente:
 *   GCP_VERTEX_CREDENTIALS_PATH             → caminho do JSON da conta de serviço
 *   GCP_STORAGE_BUCKET                      → nome do bucket GCS (ex.: siai-rag-documentos)
 *   GCP_VERTEX_DATA_STORE_ID                → ID do Data Store Agent Builder
 *   GCP_VERTEX_ENGINE_ID                    → Engine ID (Enterprise) — opcional
 *   GCP_VERTEX_SEARCH_LOCATION              → global (padrão)
 *   GCP_VERTEX_LOCATION                     → us-central1 (para Gemini)
 *   RAG_INGEST_WORKER_URL                   → URL do worker Cloud Run (opcional)
 *   RAG_INGEST_TASKS_QUEUE                  → fila Cloud Tasks (opcional)
 *   RAG_INGEST_TASKS_LOCATION               → região da fila (opcional)
 *   RAG_INGEST_TASKS_SERVICE_ACCOUNT_EMAIL  → SA OIDC (opcional)
 *
 * Compilar e rodar:
 *   mvn compile exec:java -Dexec.mainClass="br.gov.siai.rag.Main"
 */
public class Main {

    public static void main(String[] args) throws Exception {
        System.out.println("=== SIAI RAG GCP — Java ===\n");

        // ── 1. Inicializa credenciais ─────────────────────────────────────────
        GcpAuth.initVertex();
        System.out.println("Projeto GCP : " + GcpAuth.projectId());
        System.out.println("Bucket GCS  : " + GcpAuth.bucketName());
        System.out.println("Data Store  : " + GcpAuth.dataStoreId());
        System.out.println();

        // ── 2. Lista documentos no bucket ─────────────────────────────────────
        System.out.println("--- Documentos no bucket ---");
        List<Map<String, String>> docs = StorageClient.listarDocumentos(null);
        if (docs.isEmpty()) {
            System.out.println("Nenhum documento encontrado em documentos/");
        } else {
            docs.stream().limit(5).forEach(d ->
                System.out.printf("  [%s] %s (%s)%n",
                    d.get("status_label"), d.get("nome"), d.get("categoria"))
            );
            if (docs.size() > 5) {
                System.out.printf("  ... e mais %d documento(s)%n", docs.size() - 5);
            }
        }
        System.out.println();

        // ── 3. Busca semântica ────────────────────────────────────────────────
        String pergunta = args.length > 0
            ? String.join(" ", args)
            : "Quais são os procedimentos de auditoria interna?";

        System.out.println("--- Busca semântica ---");
        System.out.println("Pergunta: " + pergunta);
        System.out.println();

        List<Map<String, Object>> resultados = VertexSearch.buscarContextoInteligente(
            pergunta, null, 5);

        if (resultados.isEmpty()) {
            System.out.println("Nenhum resultado encontrado.");
        } else {
            for (int i = 0; i < resultados.size(); i++) {
                Map<String, Object> r = resultados.get(i);
                System.out.printf("[%d] %s (score: %.4f)%n",
                    i + 1, r.get("nome"), r.get("score"));
                String texto = String.valueOf(r.get("texto"));
                System.out.println("    " +
                    (texto.length() > 200 ? texto.substring(0, 200) + "..." : texto));
                System.out.println();
            }
        }

        // ── 4. Memória do usuário ─────────────────────────────────────────────
        String matricula = "demo_user";
        System.out.println("--- Memória do usuário: " + matricula + " ---");
        String memoria = MemoryManager.buscarMemoriaUsuario(matricula);
        System.out.println(memoria.isEmpty() ? "(sem memória persistida ainda)" : memoria);

        System.out.println("\n=== Concluído ===");
    }
}
