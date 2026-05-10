package br.gov.siai.rag;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.Map;

/**
 * Demo de ingestão + consulta RAG para o projeto meu-rag-java-2026.
 *
 * <p>Variáveis de ambiente obrigatórias (preencha o arquivo .env na raiz):
 * <pre>
 *   GCP_VERTEX_CREDENTIALS_PATH  → ./credentials_rag.json
 *   GCP_STORAGE_BUCKET           → meu-rag-java-docs-2026
 *   GCP_VERTEX_DATA_STORE_ID     → 79d3c94f-c30d-4e96-92bd-6398a1448a6d
 *   GCP_VERTEX_SEARCH_LOCATION   → global
 * </pre>
 *
 * <p>Como rodar (Windows):
 * <pre>
 *   start-java.bat
 * </pre>
 *
 * <p>Como rodar (Linux/Mac):
 * <pre>
 *   source .env && mvn -f java/pom.xml compile exec:java \
 *       -Dexec.mainClass="br.gov.siai.rag.MainMeuRag"
 * </pre>
 *
 * <p>Argumentos opcionais:
 * <ul>
 *   <li>Arg 1: pergunta para busca semântica</li>
 *   <li>Arg 2: caminho de um arquivo PDF/TXT para upload de teste</li>
 * </ul>
 */
public class MainMeuRag {

    public static void main(String[] args) throws Exception {
        System.out.println("╔══════════════════════════════════════════════╗");
        System.out.println("║   RAG — meu-rag-java-2026                   ║");
        System.out.println("╚══════════════════════════════════════════════╝\n");

        // ── 1. Inicializa credenciais ─────────────────────────────────────────
        GcpAuth.initVertex();

        System.out.println("Projeto GCP  : " + GcpAuth.projectId());
        System.out.println("Bucket GCS   : " + GcpAuth.bucketName());
        System.out.println("Data Store   : " + GcpAuth.dataStoreId());
        System.out.println("Localização  : " + GcpAuth.searchLocation());
        System.out.println();

        // ── 2. Módulo de Ingestão — upload de arquivo (opcional) ─────────────
        String arquivoUpload = args.length > 1 ? args[1] : null;
        if (arquivoUpload != null) {
            uploadDocumento(arquivoUpload);
        } else {
            System.out.println("[Ingestão] Nenhum arquivo informado. Para testar o upload:");
            System.out.println("           passe o caminho do arquivo como 2º argumento.\n");
        }

        // ── 3. Lista documentos no bucket ─────────────────────────────────────
        listarDocumentos();

        // ── 4. Módulo de Consulta (RAG) — busca semântica ────────────────────
        String pergunta = args.length > 0
                ? String.join(" ", java.util.Arrays.copyOfRange(args, 0, 1))
                : "Quais são os procedimentos de auditoria interna?";

        buscarRAG(pergunta);

        System.out.println("╔══════════════════════════════════════════════╗");
        System.out.println("║   Concluído                                 ║");
        System.out.println("╚══════════════════════════════════════════════╝");
    }

    // ── Módulo de Ingestão ────────────────────────────────────────────────────

    /**
     * Faz upload de um arquivo para o bucket {@code meu-rag-java-docs-2026}.
     *
     * <p>O tipo é detectado pela extensão; a categoria padrão usada é "geral".
     * Altere a chamada {@link StorageClient#salvarDocumento} para categorias específicas
     * (ex.: "auditoria", "conformidade", "procedimentos").
     *
     * @param caminhoArquivo Caminho local do arquivo PDF ou TXT.
     */
    private static void uploadDocumento(String caminhoArquivo) {
        System.out.println("─── Módulo de Ingestão ──────────────────────────");

        Path path = Path.of(caminhoArquivo);
        if (!Files.exists(path)) {
            System.out.println("[ERRO] Arquivo não encontrado: " + caminhoArquivo + "\n");
            return;
        }

        String nomeArquivo = path.getFileName().toString();
        String extensao    = nomeArquivo.contains(".")
                ? nomeArquivo.substring(nomeArquivo.lastIndexOf('.') + 1).toLowerCase()
                : "txt";

        // Valida o tipo suportado.
        if (!java.util.Set.of("pdf", "docx", "txt").contains(extensao)) {
            System.out.println("[ERRO] Tipo não suportado: " + extensao
                    + " (use pdf, docx ou txt)\n");
            return;
        }

        try {
            byte[] conteudo = Files.readAllBytes(path);
            System.out.printf("Arquivo     : %s (%,d bytes)%n", nomeArquivo, conteudo.length);
            System.out.println("Tipo        : " + extensao);
            System.out.println("Categoria   : geral");
            System.out.println("Enviando para gs://meu-rag-java-docs-2026/...");

            Map<String, String> resultado = StorageClient.salvarDocumento(
                    nomeArquivo,
                    extensao,
                    "geral",          // Categoria — altere conforme necessário.
                    "Documento enviado via demo MainMeuRag",
                    conteudo,
                    "demo_user");

            System.out.println("Blob criado : " + resultado.get("blob_name"));
            System.out.println("Status      : " + resultado.get("status_indexacao"));
        } catch (IOException e) {
            System.out.println("[ERRO] Falha no upload: " + e.getMessage());
        }

        System.out.println();
    }

    // ── Listagem de documentos ─────────────────────────────────────────────────

    private static void listarDocumentos() {
        System.out.println("─── Documentos no Bucket ────────────────────────");
        try {
            List<Map<String, String>> docs = StorageClient.listarDocumentos(null);

            if (docs.isEmpty()) {
                System.out.println("Nenhum documento encontrado em documentos/");
                System.out.println("Faça o upload de um PDF/TXT para começar.\n");
                return;
            }

            System.out.printf("Total: %d documento(s)%n%n", docs.size());
            docs.stream().limit(10).forEach(d ->
                    System.out.printf("  [%-20s] %-40s  (%s)%n",
                            d.get("status_label"),
                            d.get("nome"),
                            d.get("categoria")));

            if (docs.size() > 10) {
                System.out.printf("  ... e mais %d documento(s)%n", docs.size() - 10);
            }
        } catch (IOException e) {
            System.out.println("[ERRO] Não foi possível listar documentos: " + e.getMessage());
        }
        System.out.println();
    }

    // ── Módulo de Consulta (RAG) ──────────────────────────────────────────────

    /**
     * Consulta o Data Store via Vertex AI Search e exibe os trechos relevantes.
     *
     * @param pergunta Pergunta a ser enviada ao RAG.
     */
    private static void buscarRAG(String pergunta) {
        System.out.println("─── Módulo de Consulta (RAG) ────────────────────");
        System.out.println("Pergunta    : " + pergunta);
        System.out.println("Data Store  : " + GcpAuth.dataStoreId());
        System.out.println();

        List<Map<String, Object>> resultados =
                VertexSearch.buscarContextoInteligente(pergunta, null, 5);

        if (resultados.isEmpty()) {
            System.out.println("Nenhum resultado encontrado.");
            System.out.println("Verifique se há documentos indexados no Data Store.\n");
            return;
        }

        System.out.printf("%d resultado(s) encontrado(s):%n%n", resultados.size());

        for (int i = 0; i < resultados.size(); i++) {
            Map<String, Object> r = resultados.get(i);
            String texto = String.valueOf(r.getOrDefault("texto", ""));
            double score = ((Number) r.getOrDefault("score", 0.0)).doubleValue();

            System.out.printf("[%d] %s%n", i + 1, r.get("nome"));
            System.out.printf("    Score  : %.4f%n", score);
            System.out.printf("    URI    : %s%n", r.getOrDefault("uri", "—"));
            System.out.printf("    Trecho : %s%n%n",
                    texto.length() > 300 ? texto.substring(0, 300) + "..." : texto);
        }
    }
}