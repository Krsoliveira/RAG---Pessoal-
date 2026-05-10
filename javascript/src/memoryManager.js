/**
 * Histórico de conversas e memória persistente do auditor.
 *
 * Responsabilidade: manter o estado por usuário no Cloud Storage — histórico de
 * trocas em JSON (rolling window de 200) e perfil do auditor gerado pelo Gemini
 * Flash a cada 5 consultas.
 *
 * Espelha: ai_agents/services/memory_manager.py
 *
 * Depende de: gcpAuth, storageClient
 */

import { VertexAI } from '@google-cloud/vertexai';
import { initVertex, projectId, credentialsPath } from './gcpAuth.js';
import { gcsReadJson, gcsWriteJson } from './storageClient.js';
import logger from './logger.js';

// Tamanho máximo do histórico (rolling window).
const HISTORICO_MAX_SIZE = 200;

// Modelo Gemini Flash para sumarização (deve estar disponível no projeto GCP).
const FLASH_MODEL = process.env.GCP_VERTEX_GEMINI_FLASH_MODEL || 'gemini-2.5-flash';

// Localização do Vertex AI para chamadas de geração (ex.: us-central1).
const VERTEX_LOCATION = process.env.GCP_VERTEX_LOCATION || 'us-central1';

// ── Histórico de conversas ────────────────────────────────────────────────────

/**
 * Persiste uma troca no histórico do usuário em GCS.
 * Mantém rolling window das últimas HISTORICO_MAX_SIZE trocas.
 *
 * @param {string}   usuarioMatricula Matrícula ou ID único do usuário.
 * @param {string}   pergunta         Pergunta feita pelo auditor.
 * @param {string}   resposta         Resposta gerada pelo agente.
 * @param {string[]} documentosUsados Lista de nomes/URIs dos documentos usados.
 * @returns {Promise<void>}
 */
export async function salvarHistorico(usuarioMatricula, pergunta, resposta, documentosUsados) {
  const blobName = `historico/${usuarioMatricula}.json`;
  const historico = await gcsReadJson(blobName, []);

  historico.push({
    pergunta,
    resposta,
    documentos_usados: documentosUsados,
    data_consulta: new Date().toISOString(),
  });

  // Mantém rolling window das últimas HISTORICO_MAX_SIZE trocas.
  const janela = historico.slice(-HISTORICO_MAX_SIZE);
  await gcsWriteJson(blobName, janela);
}

/**
 * Retorna as últimas N trocas do usuário em ordem cronológica (mais antigas primeiro).
 *
 * @param {string} usuarioMatricula Matrícula ou ID único do usuário.
 * @param {number} n                Número de trocas recentes a retornar.
 * @returns {Promise<Array<{pergunta: string, resposta: string}>>}
 */
export async function buscarHistoricoRecente(usuarioMatricula, n = 10) {
  const blobName = `historico/${usuarioMatricula}.json`;
  const historico = await gcsReadJson(blobName, []);
  return historico.slice(-n).map(h => ({
    pergunta: h.pergunta || '',
    resposta: h.resposta || '',
  }));
}

// ── Memória persistente (perfil do auditor) ───────────────────────────────────

/**
 * Retorna o perfil de consultas persistido do auditor (texto livre).
 * Gerado pelo Gemini Flash e atualizado a cada 5 consultas.
 * Retorna string vazia se ainda não foi gerado.
 *
 * @param {string} usuarioMatricula Matrícula ou ID único do usuário.
 * @returns {Promise<string>} Perfil do auditor como texto, ou string vazia.
 */
export async function buscarMemoriaUsuario(usuarioMatricula) {
  const blobName = `memoria/${usuarioMatricula}.json`;
  const data = await gcsReadJson(blobName, {});
  return data.resumo || '';
}

/**
 * Atualiza a memória persistente do auditor via Gemini Flash (Vertex AI).
 * Executa apenas a cada 5 consultas para não adicionar latência em toda interação.
 * Sempre incrementa o contador total_consultas.
 *
 * @param {string} usuarioMatricula Matrícula ou ID único do usuário.
 * @returns {Promise<void>}
 */
export async function atualizarMemoriaUsuario(usuarioMatricula) {
  const blobName = `memoria/${usuarioMatricula}.json`;
  const memoria = await gcsReadJson(blobName, {});

  const total = (memoria.total_consultas || 0) + 1;
  memoria.total_consultas = total;

  // Atualiza o perfil somente a cada 5 consultas.
  if (total % 5 === 0) {
    await _regenerarPerfil(usuarioMatricula, memoria);
  }

  await gcsWriteJson(blobName, memoria);
}

// ── Privados ──────────────────────────────────────────────────────────────────

/**
 * Lê o histórico recente e pede ao Gemini Flash para gerar um perfil conciso.
 * O perfil é gravado em memoria.resumo e persistido pelo caller.
 *
 * CRÍTICO: usa o SDK @google-cloud/vertexai (conta de serviço via
 * GOOGLE_APPLICATION_CREDENTIALS), não a Developer API (GOOGLE_API_KEY).
 *
 * @param {string} usuarioMatricula Matrícula ou ID único do usuário.
 * @param {Object} memoria          Objeto de memória a ser atualizado in-place.
 * @returns {Promise<void>}
 */
async function _regenerarPerfil(usuarioMatricula, memoria) {
  const historico = await gcsReadJson(`historico/${usuarioMatricula}.json`, []);
  if (!historico.length) return;

  // Monta trecho com as últimas 30 trocas.
  const recentes = historico.slice(-30);
  const trecho = recentes.map(h => {
    const resposta = (h.resposta || '').substring(0, 400);
    return `Auditor: ${h.pergunta || ''}\nAgente: ${resposta}`;
  }).join('\n\n');

  const prompt =
    'Analise o histórico de consultas deste auditor e gere um perfil conciso (máx. 200 palavras).\n'
    + 'Inclua: principais normas/temas consultados, foco de auditoria, padrões de análise recorrentes.\n'
    + 'Este perfil será injetado no system prompt — seja objetivo e direto.\n\n'
    + trecho;

  try {
    initVertex();
    // CRÍTICO: SDK Vertex AI (conta de serviço), não Developer API (quota = 0 para gemini-2.5-pro).
    const vertexAI = new VertexAI({
      project: projectId(),
      location: VERTEX_LOCATION,
      googleAuthOptions: { keyFilename: credentialsPath() },
    });

    const model = vertexAI.getGenerativeModel({ model: FLASH_MODEL });
    const response = await model.generateContent(prompt);
    const resumo = response.response?.candidates?.[0]?.content?.parts?.[0]?.text || '';

    memoria.resumo = resumo;
    memoria.atualizado_em = new Date().toISOString();
  } catch (err) {
    logger.warn(`Erro ao atualizar memória do usuário '${usuarioMatricula}': ${err.message}`);
  }
}
