/**
 * Integração com Google Cloud Document AI para OCR de PDFs escaneados.
 *
 * Responsabilidade: detectar se um PDF tem camada de texto e, quando não tem,
 * usar o processador Document AI configurado em GCP_DOCUMENT_AI_PROCESSOR
 * para extrair o texto via reconhecimento óptico de caracteres (OCR).
 *
 * Espelha: ai_agents/services/document_ai_service.py
 *
 * Depende de: gcpAuth
 *
 * Dependência extra no package.json para leitura local de PDFs:
 *   "pdf-parse": "^1.1.1"
 *
 * Configuração via variáveis de ambiente:
 *   GCP_DOCUMENT_AI_PROCESSOR — ID do processador Document AI (obrigatório)
 *   GCP_DOCUMENT_AI_LOCATION  — Região do processador (padrão: us)
 */

import { DocumentProcessorServiceClient } from '@google-cloud/documentai';
import { initVertex, projectId, credentials, credentialsPath } from './gcpAuth.js';
import logger from './logger.js';

// Mínimo de caracteres para considerar que o PDF tem texto (não é escaneado).
const MIN_CHARS_TEXTO = 50;

// Número de páginas a inspecionar na heurística de texto (performance).
const PAGINAS_INSPECIONAR = 5;

/**
 * Limite máximo de páginas para OCR síncrono com Imageless Mode.
 * Document AI online suporta 15 páginas padrão e 30 com imageless_mode=True.
 * Para documentos maiores, é necessário BatchProcessDocuments (assíncrono).
 */
const MAX_PAGINAS_OCR = 30;

// ── Configuração do processador ───────────────────────────────────────────────

/**
 * Retorna a região do processador Document AI.
 * Usa GCP_DOCUMENT_AI_LOCATION — separado de GCP_VERTEX_LOCATION porque
 * o Document AI tem regiões e endpoints de API distintos do Vertex AI.
 *
 * @returns {string} Região (ex.: "us", "eu").
 */
export function documentAiLocation() {
  return (process.env.GCP_DOCUMENT_AI_LOCATION || 'us').trim();
}

/**
 * Monta o endpoint regional da API Document AI.
 * O Document AI expõe endpoints por região para conformidade de dados.
 * Sem isso, o cliente usa documentai.googleapis.com (global) e pode retornar 404.
 *
 * @returns {string} Endpoint regional (ex.: "us-documentai.googleapis.com").
 */
export function documentAiEndpoint() {
  return `${documentAiLocation()}-documentai.googleapis.com`;
}

/**
 * Monta o resource name completo do processador Document AI.
 * Formato: projects/{project}/locations/{location}/processors/{processor_id}
 *
 * @returns {Promise<string>} Resource name do processador.
 * @throws {Error} Se GCP_DOCUMENT_AI_PROCESSOR não estiver configurado.
 */
export async function processorName() {
  const processorId = (process.env.GCP_DOCUMENT_AI_PROCESSOR || '').trim();
  if (!processorId) {
    throw new Error(
      'GCP_DOCUMENT_AI_PROCESSOR não configurado nas variáveis de ambiente. '
      + 'Crie um processador OCR no GCP Console → Document AI e configure o ID aqui.'
    );
  }
  const pid = projectId();
  return `projects/${pid}/locations/${documentAiLocation()}/processors/${processorId}`;
}

// ── Contagem de páginas ───────────────────────────────────────────────────────

/**
 * Conta o número de páginas de um PDF sem chamar a API (sem custo).
 * Usa pdf-parse (dependência local).
 * Retorna 0 se o arquivo estiver corrompido ou não for um PDF válido.
 *
 * @param {Buffer} conteudoBytes Bytes brutos do arquivo PDF.
 * @returns {Promise<number>} Número de páginas, ou 0 em caso de erro.
 */
export async function contarPaginasPdf(conteudoBytes) {
  try {
    // Importação dinâmica para não quebrar se pdf-parse não estiver instalado.
    const pdfParse = (await import('pdf-parse')).default;
    const data = await pdfParse(conteudoBytes, { max: 0 }); // max:0 lê apenas metadados
    return data.numpages || 0;
  } catch (err) {
    logger.warn(`Não foi possível contar páginas do PDF: ${err.message}`);
    return 0;
  }
}

// ── Detecção de texto ─────────────────────────────────────────────────────────

/**
 * Heurística rápida: verifica se o PDF já tem camada de texto antes de chamar Document AI.
 * Usa pdf-parse para extrair texto das primeiras páginas.
 * Se o total de caracteres extraídos for menor que MIN_CHARS_TEXTO, considera que o
 * PDF é escaneado e precisa de OCR.
 *
 * @param {Buffer} conteudoBytes Conteúdo bruto do PDF.
 * @returns {Promise<boolean>}
 *   true  — PDF tem texto suficiente (não precisa de OCR).
 *   false — PDF é escaneado ou tem texto insuficiente (necessita OCR).
 */
export async function pdfTemTextoExtraivel(conteudoBytes) {
  try {
    const pdfParse = (await import('pdf-parse')).default;
    const data = await pdfParse(conteudoBytes, { max: PAGINAS_INSPECIONAR });
    return (data.text || '').trim().length >= MIN_CHARS_TEXTO;
  } catch (err) {
    // Em caso de erro de leitura, assume que há texto (evita OCR desnecessário).
    logger.warn(`Erro ao inspecionar texto do PDF: ${err.message} — assumindo com texto.`);
    return true;
  }
}

// ── OCR via Document AI ───────────────────────────────────────────────────────

/**
 * Extrai texto de um PDF via Google Cloud Document AI (OCR).
 *
 * Adequado para PDFs escaneados que não possuem camada de texto.
 * Usa o processador configurado em GCP_DOCUMENT_AI_PROCESSOR.
 *
 * Usa imageless_mode=true (Imageless Mode), que dobra o limite de páginas
 * do processamento online de 15 para 30 páginas, descartando as imagens
 * rasterizadas no retorno e processando somente o reconhecimento de texto.
 *
 * Recomendação de uso: verifique primeiro com pdfTemTextoExtraivel() para evitar
 * chamadas desnecessárias à API (tem custo por página).
 *
 * @param {Buffer} conteudoBytes Conteúdo bruto do arquivo PDF.
 * @returns {Promise<string>} Texto extraído. Pode ser vazio se o Document AI
 *                            não conseguir reconhecer conteúdo.
 * @throws {Error} Se GCP_DOCUMENT_AI_PROCESSOR não estiver configurado,
 *                 ou se o PDF exceder MAX_PAGINAS_OCR páginas.
 */
export async function extrairTextoPdf(conteudoBytes) {
  // Valida o número de páginas ANTES de chamar a API (evita desperdício).
  const numPaginas = await contarPaginasPdf(conteudoBytes);
  if (numPaginas > MAX_PAGINAS_OCR) {
    throw new Error(
      `O documento tem ${numPaginas} páginas e excede o limite de ${MAX_PAGINAS_OCR} `
      + `páginas para OCR online (Imageless Mode). Para documentos maiores, divida `
      + `o arquivo ou use BatchProcessDocuments.`
    );
  }
  if (numPaginas > 0) {
    logger.info(`Contagem de páginas: ${numPaginas} (limite: ${MAX_PAGINAS_OCR})`);
  }

  initVertex();
  const pName = await processorName();

  // O endpoint regional é obrigatório para processadores em regiões específicas (us, eu).
  // Sem isso, o cliente usa documentai.googleapis.com (global) e retorna 404.
  const client = new DocumentProcessorServiceClient({
    keyFilename: credentialsPath(),
    apiEndpoint: documentAiEndpoint(),
  });

  const [response] = await client.processDocument({
    name: pName,
    rawDocument: {
      content: conteudoBytes,
      mimeType: 'application/pdf',
    },
    // imageless_mode=true: dobra o limite de páginas online (15 → 30)
    // removendo imagens rasterizadas do response — reduz payload de retorno.
    imagelessMode: true,
  });

  const texto = response.document?.text || '';
  logger.info(
    `Document AI OCR concluído: ${numPaginas} páginas | ${texto.length} caracteres extraídos.`
  );
  return texto;
}
