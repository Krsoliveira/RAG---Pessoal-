/**
 * Ponto de entrada — re-exporta todos os módulos do RAG GCP.
 *
 * Equivalente ao ai_agents/rag.py (shim) do Python.
 * Importar daqui mantém compatibilidade; novos módulos devem
 * importar diretamente dos arquivos de serviço.
 */

// ── gcpAuth ───────────────────────────────────────────────────────────────────
export {
  credentialsPath,
  projectId,
  credentials,
  initVertex,
  bucketName,
  storageClient,
  dataStoreId,
  searchLocation,
  engineId,
  servingConfig,
} from './gcpAuth.js';

// ── storageClient ─────────────────────────────────────────────────────────────
export {
  gcsReadJson,
  gcsWriteJson,
  nomeDoBlobName,
  statusIndexacaoBlob,
  statusCss,
  statusLabel,
  listarDocumentos,
  contarDocumentos,
  contarDocumentosCategoria,
  salvarDocumento,
  baixarBlob,
  salvarTextoOcr,
  importarGcsParaVertex,
  removerDocumento,
  arquivarComoLegado,
} from './storageClient.js';

// ── vertexSearch ──────────────────────────────────────────────────────────────
export {
  buscarContextoInteligente,
  extrairChunks,
  extrairTextos,
  consolidarChunks,
  campo,
} from './vertexSearch.js';

// ── memoryManager ─────────────────────────────────────────────────────────────
export {
  salvarHistorico,
  buscarHistoricoRecente,
  buscarMemoriaUsuario,
  atualizarMemoriaUsuario,
} from './memoryManager.js';

// ── ingestPipeline ────────────────────────────────────────────────────────────
export {
  processarPayloadIngestao,
  IngestIrrecoverableError,
  IngestRecoverableError,
} from './ingestPipeline.js';

// ── tasksClient ───────────────────────────────────────────────────────────────
export { despacharTarefaProcessamento } from './tasksClient.js';

// ── documentAiService ─────────────────────────────────────────────────────────
export {
  documentAiLocation,
  documentAiEndpoint,
  processorName,
  contarPaginasPdf,
  pdfTemTextoExtraivel,
  extrairTextoPdf,
} from './documentAiService.js';

// ── queryOrchestrator ─────────────────────────────────────────────────────────
export { retrieveContext, shouldBlockAnswer } from './queryOrchestrator.js';
