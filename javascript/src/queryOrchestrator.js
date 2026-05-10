/**
 * Camada de orquestração do fluxo retrieve → policy gate.
 *
 * Responsabilidade: manter os handlers/controllers enxutos e centralizar a lógica
 * de recuperação de contexto e bloqueio de respostas.
 *
 * Espelha: ai_agents/services/query_orchestrator.py
 *
 * Depende de: vertexSearch
 */

import { randomUUID } from 'crypto';
import { buscarContextoInteligente } from './vertexSearch.js';
import logger from './logger.js';

// ── Recuperação de contexto ───────────────────────────────────────────────────

/**
 * Busca contexto no Vertex AI Agent Builder e retorna métricas de qualidade.
 *
 * Gera um request_id único por chamada para facilitar rastreabilidade em logs.
 *
 * @param {string}      pergunta  Texto da pergunta do auditor.
 * @param {string|null} categoria Filtro de categoria (null = todas).
 * @param {number}      topK      Número máximo de documentos a retornar.
 * @returns {Promise<{request_id: string, docs: Array, score_medio: number}>}
 */
export async function retrieveContext(pergunta, categoria = null, topK = 10) {
  const requestId = randomUUID().replace(/-/g, '').substring(0, 12);

  const docs = await buscarContextoInteligente(pergunta, categoria, topK);

  const scoreMedio = docs.length
    ? Math.round(
        (docs.reduce((acc, d) => acc + (parseFloat(d.score) || 0), 0) / docs.length)
        * 10_000
      ) / 10_000
    : 0;

  logger.info(
    `rag_retrieve request_id=${requestId} categoria=${categoria || 'todas'} `
    + `docs=${docs.length} score_medio=${scoreMedio}`
  );

  return { request_id: requestId, docs, score_medio: scoreMedio };
}

// ── Policy gate ───────────────────────────────────────────────────────────────

/**
 * Bloqueia resposta apenas quando não há nenhum conteúdo recuperado.
 *
 * O modelo Gemini decide se o conteúdo é suficiente para responder com qualidade
 * — este gate apenas verifica ausência total de contexto.
 *
 * @param {Array}  docs     Lista de documentos recuperados por retrieveContext.
 * @param {string} pergunta Pergunta original (para customização futura da mensagem).
 * @returns {{bloqueado: boolean, mensagem: string}}
 */
export function shouldBlockAnswer(docs, pergunta) {
  if (!docs || docs.length === 0) {
    return {
      bloqueado: true,
      mensagem:  'Não encontrei evidências suficientes na base para responder com segurança.',
    };
  }

  const textoTotal = docs
    .map(d => String(d.texto || ''))
    .join(' ')
    .trim();

  if (!textoTotal) {
    return {
      bloqueado: true,
      mensagem:  'Os trechos recuperados estavam vazios. '
               + 'Refaça a pergunta ou aguarde a indexação completar.',
    };
  }

  return { bloqueado: false, mensagem: '' };
}
