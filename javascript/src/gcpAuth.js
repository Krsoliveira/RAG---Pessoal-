/**
 * Camada de autenticação e configuração GCP.
 *
 * Responsabilidade única: resolver credenciais e construir clientes GCP.
 * Todos os outros módulos importam daqui — nunca o contrário.
 *
 * Espelha: ai_agents/services/gcp_auth.py
 *
 * Hierarquia de dependência:
 *   gcpAuth  ←  storageClient  ←  memoryManager
 *   gcpAuth  ←  vertexSearch
 *
 * Configuração via variáveis de ambiente:
 *   GCP_VERTEX_CREDENTIALS_PATH  — caminho do JSON de conta de serviço
 *   BASE_DIR                     — raiz do projeto (fallback de credenciais)
 *   GCP_STORAGE_BUCKET           — nome do bucket GCS
 *   GCP_VERTEX_DATA_STORE_ID     — ID do Data Store do Agent Builder
 *   GCP_VERTEX_SEARCH_LOCATION   — localização do Vertex AI Search (padrão: global)
 *   GCP_VERTEX_ENGINE_ID         — Engine ID do Search App Enterprise (opcional)
 */

import { readFileSync } from 'fs';
import { join } from 'path';
import { GoogleAuth } from 'google-auth-library';
import { Storage } from '@google-cloud/storage';
import logger from './logger.js';

// Garante que a inicialização do Vertex só ocorra uma vez por processo.
let _vertexInitDone = false;

// ── Credenciais e projeto ─────────────────────────────────────────────────────

/**
 * Resolve o caminho do JSON da conta de serviço RAG (sa-rag-api).
 * Prioridade: GCP_VERTEX_CREDENTIALS_PATH → BASE_DIR/config/credentials_rag.json
 *
 * @returns {string} Caminho absoluto para o arquivo de credenciais.
 */
export function credentialsPath() {
  const raw = (process.env.GCP_VERTEX_CREDENTIALS_PATH || '').trim();
  if (raw) return raw;
  const baseDir = process.env.BASE_DIR || '.';
  return join(baseDir, 'config', 'credentials_rag.json');
}

/**
 * Lê o project_id diretamente do arquivo JSON da conta de serviço.
 *
 * @returns {string} ID do projeto GCP.
 * @throws {Error} Se o campo project_id estiver ausente no arquivo.
 */
export function projectId() {
  const data = JSON.parse(readFileSync(credentialsPath(), 'utf-8'));
  if (!data.project_id) {
    throw new Error("Arquivo de credenciais GCP sem campo 'project_id'.");
  }
  return data.project_id;
}

/**
 * Cria um cliente GoogleAuth autenticado com a conta de serviço.
 * Usado para obter tokens OIDC e access tokens.
 *
 * @returns {GoogleAuth}
 */
export function credentials() {
  return new GoogleAuth({
    keyFile: credentialsPath(),
    scopes: ['https://www.googleapis.com/auth/cloud-platform'],
  });
}

/**
 * Seta GOOGLE_APPLICATION_CREDENTIALS no ambiente (idempotente).
 * Todos os clientes GCP usam essa variável automaticamente.
 * Equivalente a _init_vertex() no Python.
 */
export function initVertex() {
  if (_vertexInitDone) return;
  process.env.GOOGLE_APPLICATION_CREDENTIALS = credentialsPath();
  _vertexInitDone = true;
  logger.debug(`GOOGLE_APPLICATION_CREDENTIALS configurado: ${credentialsPath()}`);
}

// ── Cloud Storage — cliente e bucket ─────────────────────────────────────────

/**
 * Retorna o nome do bucket GCS configurado em GCP_STORAGE_BUCKET.
 *
 * @returns {string} Nome do bucket.
 * @throws {Error} Se a variável de ambiente não estiver configurada.
 */
export function bucketName() {
  const bucket = (process.env.GCP_STORAGE_BUCKET || '').trim();
  if (!bucket) {
    throw new Error('GCP_STORAGE_BUCKET não configurado nas variáveis de ambiente.');
  }
  return bucket;
}

/**
 * Retorna cliente Cloud Storage autenticado com a conta de serviço.
 *
 * @returns {Storage}
 */
export function storageClient() {
  return new Storage({
    keyFilename: credentialsPath(),
    projectId: projectId(),
  });
}

// ── Vertex AI Agent Builder — configuração de busca ──────────────────────────

/**
 * Retorna o ID do Data Store do Agent Builder.
 * Padrão: banco-comigo-auditoria_1777308243982
 *
 * @returns {string}
 */
export function dataStoreId() {
  return process.env.GCP_VERTEX_DATA_STORE_ID
    || 'banco-comigo-auditoria_1777308243982';
}

/**
 * Retorna a localização do Vertex AI Search.
 * Padrão: global
 *
 * @returns {string}
 */
export function searchLocation() {
  return process.env.GCP_VERTEX_SEARCH_LOCATION || 'global';
}

/**
 * Retorna o Engine ID do Search App Enterprise.
 * Vazio = busca usa o Data Store diretamente (modo Standard).
 *
 * @returns {string}
 */
export function engineId() {
  return (process.env.GCP_VERTEX_ENGINE_ID || '').trim();
}

/**
 * Monta o resource path completo do serving config para o SearchServiceClient.
 *
 * Com Engine ID (Enterprise): suporta extractive_segments e extractive_answers.
 * Sem Engine ID (Standard): retorna apenas snippets.
 *
 * @param {string} project  ID do projeto GCP.
 * @param {string} location Localização do Vertex AI Search (ex.: global).
 * @returns {string} Path completo do serving config.
 */
export function servingConfig(project, location) {
  const eid = engineId();
  if (eid) {
    return `projects/${project}/locations/${location}/collections/default_collection`
      + `/engines/${eid}/servingConfigs/default_config`;
  }
  return `projects/${project}/locations/${location}/collections/default_collection`
    + `/dataStores/${dataStoreId()}/servingConfigs/default_config`;
}
