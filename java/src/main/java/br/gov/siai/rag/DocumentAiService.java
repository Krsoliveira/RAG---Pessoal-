package br.gov.siai.rag;

import com.google.api.gax.core.FixedCredentialsProvider;
import com.google.cloud.documentai.v1.*;
import com.google.protobuf.ByteString;
import org.apache.pdfbox.pdmodel.PDDocument;
import org.apache.pdfbox.text.PDFTextStripper;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.io.IOException;

/**
 * Integração com Google Cloud Document AI para OCR de PDFs escaneados.
 *
 * <p>Responsabilidade: detectar se um PDF tem camada de texto e, quando não tem,
 * usar o processador Document AI configurado em {@code GCP_DOCUMENT_AI_PROCESSOR}
 * para extrair o texto via reconhecimento óptico de caracteres (OCR).
 *
 * <p>Espelha: {@code ai_agents/services/document_ai_service.py}
 *
 * <p>Depende de: {@link GcpAuth}
 *
 * <p>Dependência extra no pom.xml para leitura local de PDFs:
 * <pre>{@code
 * <dependency>
 *   <groupId>org.apache.pdfbox</groupId>
 *   <artifactId>pdfbox</artifactId>
 *   <version>3.0.2</version>
 * </dependency>
 * }</pre>
 *
 * <p>Configuração via variáveis de ambiente:
 * <ul>
 *   <li>{@code GCP_DOCUMENT_AI_PROCESSOR} — ID do processador Document AI (obrigatório)</li>
 *   <li>{@code GCP_DOCUMENT_AI_LOCATION}  — Região do processador (padrão: us)</li>
 * </ul>
 */
public final class DocumentAiService {

    private static final Logger log = LoggerFactory.getLogger(DocumentAiService.class);

    // Mínimo de caracteres para considerar que o PDF tem texto (não é escaneado).
    private static final int MIN_CHARS_TEXTO = 50;

    // Número de páginas a inspecionar na heurística de texto (performance).
    private static final int PAGINAS_INSPECIONAR = 5;

    /**
     * Limite máximo de páginas para OCR síncrono com Imageless Mode.
     * Document AI online suporta 15 páginas padrão e 30 com imageless_mode=True.
     * Para documentos maiores, é necessário BatchProcessDocuments (assíncrono).
     */
    private static final int MAX_PAGINAS_OCR = 30;

    private DocumentAiService() {}

    // ── Configuração do processador ───────────────────────────────────────────

    /**
     * Retorna a região do processador Document AI.
     * Usa {@code GCP_DOCUMENT_AI_LOCATION} — separado de {@code GCP_VERTEX_LOCATION}
     * porque o Document AI tem regiões e endpoints de API distintos do Vertex AI.
     */
    public static String documentAiLocation() {
        String loc = System.getenv("GCP_DOCUMENT_AI_LOCATION");
        return (loc != null && !loc.isBlank()) ? loc.strip() : "us";
    }

    /**
     * Monta o endpoint regional da API Document AI.
     *
     * <p>O Document AI expõe endpoints por região para conformidade de dados
     * (ex.: {@code us-documentai.googleapis.com}, {@code eu-documentai.googleapis.com}).
     * Sem isso, o cliente usa o endpoint global que pode não rotear para o
     * processador regional correto, causando 404.
     */
    public static String documentAiEndpoint() {
        return documentAiLocation() + "-documentai.googleapis.com:443";
    }

    /**
     * Monta o resource name completo do processador Document AI.
     *
     * <p>Formato: {@code projects/{project}/locations/{location}/processors/{processor_id}}
     *
     * @return Resource name do processador.
     * @throws IllegalStateException se {@code GCP_DOCUMENT_AI_PROCESSOR} não estiver configurado.
     * @throws IOException se o project_id não puder ser lido das credenciais.
     */
    public static String processorName() throws IOException {
        String processorId = (System.getenv("GCP_DOCUMENT_AI_PROCESSOR") != null
                ? System.getenv("GCP_DOCUMENT_AI_PROCESSOR")
                : "").strip();
        if (processorId.isEmpty()) {
            throw new IllegalStateException(
                    "GCP_DOCUMENT_AI_PROCESSOR não configurado nas variáveis de ambiente. "
                    + "Crie um processador OCR no GCP Console → Document AI e configure o ID aqui.");
        }
        return String.format("projects/%s/locations/%s/processors/%s",
                GcpAuth.projectId(), documentAiLocation(), processorId);
    }

    // ── Contagem de páginas ───────────────────────────────────────────────────

    /**
     * Conta o número de páginas de um PDF usando PDFBox (sem custo de API).
     * Retorna 0 se o arquivo estiver corrompido ou não for um PDF válido.
     *
     * @param conteudoBytes Bytes brutos do arquivo PDF.
     * @return Número de páginas, ou 0 em caso de erro.
     */
    public static int contarPaginasPdf(byte[] conteudoBytes) {
        try (PDDocument doc = PDDocument.load(conteudoBytes)) {
            return doc.getNumberOfPages();
        } catch (Exception e) {
            log.warn("Não foi possível contar páginas do PDF: {}", e.getMessage());
            return 0;
        }
    }

    // ── Detecção de texto ─────────────────────────────────────────────────────

    /**
     * Heurística rápida: verifica se o PDF já tem camada de texto antes de chamar Document AI.
     *
     * <p>Usa PDFBox para tentar extrair texto das primeiras páginas. Se o total
     * de caracteres extraídos for menor que {@code MIN_CHARS_TEXTO}, considera que o
     * PDF é escaneado e precisa de OCR.
     *
     * @param conteudoBytes Conteúdo bruto do PDF.
     * @return {@code true} — PDF tem texto suficiente (não precisa de OCR).
     *         {@code false} — PDF é escaneado ou tem texto insuficiente (necessita OCR).
     */
    public static boolean pdfTemTextoExtraivel(byte[] conteudoBytes) {
        try (PDDocument doc = PDDocument.load(conteudoBytes)) {
            PDFTextStripper stripper = new PDFTextStripper();
            StringBuilder textoTotal = new StringBuilder();
            int paginas = Math.min(doc.getNumberOfPages(), PAGINAS_INSPECIONAR);
            for (int i = 1; i <= paginas; i++) {
                stripper.setStartPage(i);
                stripper.setEndPage(i);
                textoTotal.append(stripper.getText(doc));
                if (textoTotal.toString().strip().length() >= MIN_CHARS_TEXTO) return true;
            }
            return textoTotal.toString().strip().length() >= MIN_CHARS_TEXTO;
        } catch (Exception e) {
            // Em caso de erro de leitura, assume que há texto (evita OCR desnecessário).
            log.warn("Erro ao inspecionar texto do PDF: {} — assumindo com texto.", e.getMessage());
            return true;
        }
    }

    // ── OCR via Document AI ───────────────────────────────────────────────────

    /**
     * Extrai texto de um PDF via Google Cloud Document AI (OCR).
     *
     * <p>Adequado para PDFs escaneados que não possuem camada de texto.
     * Usa o processador configurado em {@code GCP_DOCUMENT_AI_PROCESSOR}.
     *
     * <p>Usa {@code imageless_mode=true} (Imageless Mode), que dobra o limite de páginas
     * do processamento online de 15 para 30 páginas, descartando as imagens rasterizadas
     * no retorno e processando somente o reconhecimento de texto.
     *
     * <p>Recomendação de uso: verifique primeiro com {@link #pdfTemTextoExtraivel} para evitar
     * chamadas desnecessárias à API (tem custo por página).
     *
     * @param conteudoBytes Conteúdo bruto do arquivo PDF.
     * @return Texto extraído como string. Pode ser vazio se o Document AI
     *         não conseguir reconhecer conteúdo.
     * @throws IllegalStateException se {@code GCP_DOCUMENT_AI_PROCESSOR} não estiver configurado,
     *                               ou se o PDF exceder {@code MAX_PAGINAS_OCR} páginas.
     * @throws IOException  se a chamada à API Document AI falhar.
     */
    public static String extrairTextoPdf(byte[] conteudoBytes) throws IOException {
        // Valida o número de páginas ANTES de chamar a API (evita desperdício).
        int numPaginas = contarPaginasPdf(conteudoBytes);
        if (numPaginas > MAX_PAGINAS_OCR) {
            throw new IllegalStateException(String.format(
                    "O documento tem %d páginas e excede o limite de %d páginas para OCR online "
                    + "(Imageless Mode). Para documentos maiores, divida o arquivo ou use "
                    + "BatchProcessDocuments.",
                    numPaginas, MAX_PAGINAS_OCR));
        }
        if (numPaginas > 0) {
            log.info("Contagem de páginas: {} (limite: {})", numPaginas, MAX_PAGINAS_OCR);
        }

        GcpAuth.initVertex();
        String pName = processorName();

        // O endpoint regional é obrigatório para processadores em regiões específicas (us, eu).
        // Sem isso, o cliente usa documentai.googleapis.com (global) e retorna 404.
        DocumentProcessorServiceSettings settings = DocumentProcessorServiceSettings.newBuilder()
                .setEndpoint(documentAiEndpoint())
                .setCredentialsProvider(
                        FixedCredentialsProvider.create(GcpAuth.credentials()))
                .build();

        try (DocumentProcessorServiceClient client =
                     DocumentProcessorServiceClient.create(settings)) {

            RawDocument rawDoc = RawDocument.newBuilder()
                    .setContent(ByteString.copyFrom(conteudoBytes))
                    .setMimeType("application/pdf")
                    .build();

            // imageless_mode=true: dobra o limite de páginas online (15 → 30)
            // removendo imagens rasterizadas do response — reduz payload de retorno.
            ProcessRequest request = ProcessRequest.newBuilder()
                    .setName(pName)
                    .setRawDocument(rawDoc)
                    .setImagelessMode(true)
                    .build();

            ProcessResponse response = client.processDocument(request);
            String texto = response.getDocument().getText();

            log.info("Document AI OCR concluído: {} páginas | {} caracteres extraídos.",
                    numPaginas, texto.length());
            return texto != null ? texto : "";
        }
    }
}
