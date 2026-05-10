/**
 * Busca semântica via Vertex AI Agent Builder (Enterprise Search).
 *
 * Responsabilidade: encapsular todo o protocolo do SearchServiceClient —
 * serving config, iteração do pager, extração de conteúdo e consolidação de
 * chunks por documento.
 *
 * Espelha: ai_agents/services/vertex_search.py
 *
 * Depende de: gcpAuth
 */

import { SearchServiceClient } from '@google-cloud/discoveryengine';
import {
  initVertex,
  credentialsPath,
  projectId,
  searchLocation,
  servingConfig,
} from './gcpAuth.js';
import logger from './logger.js';

// Regex para limpar prefixo gs://bucket/documentos/{categoria}/ e UUID do nome.
const GCS_PREFIX_PATTERN = /^gs:\/\/[^/]+\/documentos\/[^/]+\//;
const UUID_PREFIX_PATTERN = /^(?:\d+|[a-f0-9]{12})_/;
const HTML_TAG_PATTERN    = /<[^<]+>/g;

// ── Busca principal ───────────────────────────────────────────────────────────

/**
 * Retorna trechos relevantes via Vertex AI Agent Builder Search.
 *
 * Estratégia de extração de texto (em ordem de prioridade):
 *   1. extractive_segments — trechos longos do documento, ideais para RAG.
 *   2. extractive_answers  — resposta direta à query (Enterprise Edition).
 *   3. snippets            — fallback quando os anteriores não retornam conteúdo.
 *
 * @param {string}      pergunta  Texto da pergunta ou consulta.
 * @param {string|null} categoria Filtro opcional de categoria (null = todas).
 * @param {number}      topK      Número máximo de resultados a retornar.
 * @returns {Promise<Array<{nome: string, uri: string, texto: string, score: number}>>}
 */
export async function buscarContextoInteligente(pergunta, categoria = null, topK = 10) {
  initVertex();

  try {
    const pid      = projectId();
    const location = searchLocation();
    const srvConfig = servingConfig(pid, location);

    const client = new SearchServiceClient({ keyFilename: credentialsPath() });

    const request = {
      servingConfig: srvConfig,
      query: pergunta,
      pageSize: topK,
      contentSearchSpec: {
        snippetSpec: {
          returnSnippet: true,
          maxSnippetCount: 5,
        },
        extractiveContentSpec: {
          maxExtractiveAnswerCount: 2,
          maxExtractiveSegmentCount: 5,
        },
      },
    };

    // IMPORTANTE: usar o pager diretamente (searchStream ou iterateAll),
    // não só o primeiro resultado — equivalente ao list(response) do Python.
    const results = [];
    const [response] = await client.search(request);
    // A biblioteca Node.js retorna os resultados na primeira chamada
    if (Array.isArray(response)) {
      results.push(...response);
    }

    // Fallback: usa o método de stream para garantir que todos os resultados são coletados.
    if (results.length === 0) {
      for await (const result of client.searchAsync(request)) {
        results.push(result);
      }
    }

    logger.info(
      `Agent Builder search: ${results.length} resultado(s) | serving_config=${srvConfig} | `
      + `query='${pergunta.substring(0, 60)}' | categoria=${categoria || 'todas'}`
    );

    let chunks = extrairChunks(results);
    logger.info(`Chunks extraídos: ${chunks.length} | categoria=${categoria || 'todas'}`);

    // Filtra por categoria verificando o URI do blob.
    if (categoria) {
      chunks = chunks.filter(c => (c.uri || '').toLowerCase().includes(`/${categoria}/`));
    }

    return consolidarChunks(chunks, topK);

  } catch (err) {
    logger.warn(`Erro no Vertex AI Search: ${err.message}`);
    return [];
  }
}

// ── Extração de chunks ────────────────────────────────────────────────────────

/**
 * Percorre os resultados do Agent Builder e extrai chunks de texto.
 *
 * @param {Array} results Lista de resultados do Agent Builder Search.
 * @returns {Array<{nome: string, uri: string, texto: string, score: number}>}
 */
export function extrairChunks(results) {
  const chunks = [];

  for (const result of results) {
    const doc = result.document || {};

    // derivedStructData contém os campos indexados — converte para objeto JS puro.
    const dsd = converterStructData(doc.derivedStructData);

    let docName = dsd.title || doc.id || 'Documento';
    const score = parseFloat(
      Object.values(result.modelScores || {})?.[0]?.values?.[0] ?? 0
    ) || 0;

    const textos = extrairTextos(dsd, docName);
    const gcsUri = String(dsd.link || '');

    // Remove prefixo gs://bucket/documentos/{categoria}/ e UUID do nome.
    let nomeLimpo = docName.replace(GCS_PREFIX_PATTERN, '');
    nomeLimpo = nomeLimpo.replace(UUID_PREFIX_PATTERN, '');

    for (const texto of textos) {
      const textoLimpo = texto.replace(HTML_TAG_PATTERN, '').trim();
      if (textoLimpo) {
        chunks.push({
          nome:  nomeLimpo || docName,
          uri:   gcsUri,
          texto: textoLimpo,
          score,
        });
      }
    }
  }

  return chunks;
}

/**
 * Extrai lista de textos de um resultado, seguindo a hierarquia de prioridade.
 * Ordem: extractive_segments → extractive_answers → snippets.
 *
 * @param {Object} dsd     Objeto derivedStructData convertido para JS puro.
 * @param {string} docName Nome do documento (para log de depuração).
 * @returns {string[]} Lista de textos extraídos.
 */
export function extrairTextos(dsd, docName) {
  const textos = [];

  // 1. extractive_segments — trechos longos, melhor para RAG.
  const segments = Array.isArray(dsd.extractive_segments) ? dsd.extractive_segments : [];
  for (const seg of segments.slice(0, 3)) {
    const content = campo(seg, 'content');
    if (content) textos.push(content);
  }

  // 2. extractive_answers — resposta direta à query.
  if (!textos.length) {
    const answers = Array.isArray(dsd.extractive_answers) ? dsd.extractive_answers : [];
    for (const ans of answers.slice(0, 2)) {
      const content = campo(ans, 'content');
      if (content) textos.push(content);
    }
  }

  // 3. snippets — fallback mínimo.
  if (!textos.length) {
    const snippets = Array.isArray(dsd.snippets) ? dsd.snippets : [];
    for (const snip of snippets.slice(0, 3)) {
      const content = campo(snip, 'snippet');
      if (content) textos.push(content);
    }
  }

  if (!textos.length) {
    logger.debug(
      `Resultado sem texto extraível | doc=${docName} | dsd_keys=${Object.keys(dsd)}`
    );
  }

  return textos;
}

// ── Consolidação de chunks ────────────────────────────────────────────────────

/**
 * Agrupa chunks pelo URI do documento e retorna os mais relevantes.
 * Para cada documento, mantém no máximo 2 trechos únicos (maior score primeiro).
 * Isso melhora a cobertura factual sem repetir conteúdo do mesmo arquivo.
 *
 * @param {Array} chunks Lista de chunks extraídos.
 * @param {number} topK  Número máximo de documentos consolidados.
 * @returns {Array} Lista consolidada ordenada por score decrescente.
 */
export function consolidarChunks(chunks, topK = 10) {
  // Agrupa chunks por URI (ou nome, se URI vazio).
  const byUri = new Map();
  for (const chunk of chunks) {
    const key = chunk.uri || chunk.nome || 'unknown';
    if (!byUri.has(key)) byUri.set(key, []);
    byUri.get(key).push(chunk);
  }

  const consolidados = [];
  for (const grouped of byUri.values()) {
    // Ordena por score decrescente dentro do grupo.
    grouped.sort((a, b) => (b.score || 0) - (a.score || 0));

    // Mantém no máximo 2 trechos únicos por documento.
    const topTrechos = [];
    for (const item of grouped) {
      const texto = (item.texto || '').trim();
      if (texto && !topTrechos.includes(texto)) topTrechos.push(texto);
      if (topTrechos.length >= 2) break;
    }

    if (!topTrechos.length) continue;

    const principal = grouped[0];
    consolidados.push({
      nome:  principal.nome || 'Documento',
      uri:   principal.uri  || '',
      texto: topTrechos.join('\n\n'),
      score: principal.score || 0,
    });
  }

  // Ordena consolidados por score decrescente e limita ao topK.
  return consolidados
    .sort((a, b) => (b.score || 0) - (a.score || 0))
    .slice(0, topK);
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Lê um campo de um objeto que pode ser um objeto JS puro ou um protobuf MapComposite.
 * Aceita múltiplas chaves como fallback (retorna o primeiro valor não vazio).
 *
 * Equivale a _campo() no Python que trata MapComposite com dict(obj).
 *
 * @param {Object} obj   Objeto a inspecionar.
 * @param {...string} chaves Chaves a tentar em ordem.
 * @returns {string} Primeiro valor não vazio encontrado, ou string vazia.
 */
export function campo(obj, ...chaves) {
  // Converte proto-plus MapComposite para objeto JS se necessário.
  const d = (obj && typeof obj.toObject === 'function') ? obj.toObject() : (obj || {});
  for (const chave of chaves) {
    const val = d[chave];
    if (val !== undefined && val !== null && String(val).trim()) {
      return String(val).trim();
    }
  }
  return '';
}

/**
 * Converte o derivedStructData proto para um objeto JS puro.
 *
 * O SDK Node.js retorna o Struct do proto como objeto com a estrutura:
 *   { fields: { chave: { stringValue/listValue/structValue/..., kind } } }
 *
 * Esta função converte recursivamente esse formato para um objeto JS simples.
 *
 * @param {Object|null} structData derivedStructData do resultado.
 * @returns {Object} Objeto JS puro.
 */
function converterStructData(structData) {
  if (!structData) return {};
  if (typeof structData.toObject === 'function') return structData.toObject();
  // Formato protobuf Struct: { fields: { key: Value, ... } }
  if (structData.fields && typeof structData.fields === 'object') {
    return protoStructToJs(structData);
  }
  return structData;
}

/**
 * Converte recursivamente um protobuf Struct/Value para JS puro.
 * Struct  → { fields: { key: Value } }
 * List    → { listValue: { values: [Value] } }
 * Value   → { stringValue | numberValue | boolValue | nullValue | structValue | listValue }
 */
function protoStructToJs(value) {
  if (value === null || value === undefined) return null;

  // Struct com campos
  if (value.fields && typeof value.fields === 'object') {
    const obj = {};
    for (const [k, v] of Object.entries(value.fields)) {
      obj[k] = protoStructToJs(v);
    }
    return obj;
  }

  // Usa o discriminador "kind" quando disponível
  const kind = value.kind;
  if (kind === 'stringValue'  || value.stringValue  !== undefined) return value.stringValue  ?? '';
  if (kind === 'numberValue'  || value.numberValue  !== undefined) return value.numberValue  ?? 0;
  if (kind === 'boolValue'    || value.boolValue    !== undefined) return value.boolValue    ?? false;
  if (kind === 'nullValue'    || value.nullValue     !== undefined) return null;

  if (kind === 'listValue' || value.listValue !== undefined) {
    const vals = value.listValue?.values ?? [];
    return vals.map(protoStructToJs);
  }

  if (kind === 'structValue' || value.structValue !== undefined) {
    return protoStructToJs(value.structValue);
  }

  // Fallback: já é objeto JS puro
  return value;
}
