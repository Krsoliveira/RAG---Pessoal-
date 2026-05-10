/**
 * Operações no Cloud Storage e CRUD de documentos.
 *
 * Responsabilidade: qualquer leitura ou escrita de blobs no bucket GCS passa
 * por este módulo — upload de documentos, remoção, listagem, JSON de estado.
 *
 * Espelha: ai_agents/services/storage_client.py
 *
 * Depende de: gcpAuth, tasksClient
 */

import { randomUUID } from 'crypto';
import { basename } from 'path';
import {
  initVertex,
  storageClient,
  bucketName,
  projectId,
  searchLocation,
  dataStoreId,
} from './gcpAuth.js';
import { despacharTarefaProcessamento } from './tasksClient.js';
import { DocumentServiceClient } from '@google-cloud/discoveryengine';
import logger from './logger.js';

// Janela de tempo (ms) em que um blob recém-criado é considerado "indexando".
const INDEX_GRACE_MS = 20 * 60 * 1000;

// MIME types aceitos para upload de documentos base.
const MIME_TYPES = {
  pdf:  'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  txt:  'text/plain',
};

// Regex para remover prefixo de ID gerado automaticamente no nome do arquivo.
const PREFIX_PATTERN = /^(?:\d+|[a-f0-9]{8}|[a-f0-9]{12})_/;

// ── Helpers JSON (baixo nível) ────────────────────────────────────────────────

/**
 * Lê blob JSON do GCS; retorna defaultValue se o blob não existir ou falhar.
 *
 * @param {string} blobName   Caminho completo do blob (ex.: historico/001.json).
 * @param {*}      defaultValue Valor retornado em caso de ausência ou erro.
 * @returns {Promise<*>} Objeto JSON deserializado ou defaultValue.
 */
export async function gcsReadJson(blobName, defaultValue = []) {
  try {
    const bucket = storageClient().bucket(bucketName());
    const [contents] = await bucket.file(blobName).download();
    return JSON.parse(contents.toString('utf-8'));
  } catch (err) {
    if (err.code !== 404) {
      logger.warn(`Erro ao ler JSON do GCS '${blobName}': ${err.message}`);
    }
    return defaultValue;
  }
}

/**
 * Serializa data como JSON e salva no GCS sobrescrevendo o blob.
 *
 * @param {string} blobName Caminho completo do blob no GCS.
 * @param {*}      data     Objeto a serializar e persistir.
 * @returns {Promise<void>}
 */
export async function gcsWriteJson(blobName, data) {
  const bucket = storageClient().bucket(bucketName());
  const json = JSON.stringify(data, null, 2);
  await bucket.file(blobName).save(json, {
    contentType: 'application/json',
    metadata: { contentEncoding: 'utf-8' },
  });
}

// ── Helpers de nome e status ──────────────────────────────────────────────────

/**
 * Extrai o nome original do arquivo a partir do blobName ou metadata.
 * Prioriza metadata.nome_original; senão remove prefixo de UUID/ID gerado automaticamente.
 *
 * @param {string} blobName Nome do blob no GCS.
 * @param {Object} metadata Metadata do blob (pode ser null/undefined).
 * @returns {string} Nome limpo do arquivo.
 */
export function nomeDoBlobName(blobName, metadata) {
  if (metadata?.nome_original) return metadata.nome_original;
  const raw = basename(blobName);
  return raw.replace(PREFIX_PATTERN, '');
}

/**
 * Deriva status de indexação com base em metadata e janela de tempo desde o upload.
 *
 * @param {Object} blobMetadata   Metadata do blob (objeto chave-valor).
 * @param {Date|null} timeCreated Data de criação do blob.
 * @returns {string} Status: "indexado", "indexando", "aguardando" ou "erro".
 */
export function statusIndexacaoBlob(blobMetadata, timeCreated) {
  const metadata = blobMetadata || {};
  const statusMeta = (metadata.status_indexacao || '').trim().toLowerCase();

  const validStatuses = new Set(['erro', 'indexado', 'indexando', 'aguardando']);
  if (validStatuses.has(statusMeta)) {
    if (statusMeta === 'indexando' && timeCreated) {
      const age = Date.now() - new Date(timeCreated).getTime();
      return age > INDEX_GRACE_MS ? 'erro' : 'indexando';
    }
    return statusMeta;
  }

  // Sem metadata de status: infere pela janela de tempo.
  if (timeCreated) {
    const age = Date.now() - new Date(timeCreated).getTime();
    return age < INDEX_GRACE_MS ? 'indexando' : 'indexado';
  }
  return 'indexado';
}

/**
 * Retorna classe CSS correspondente ao status de indexação.
 *
 * @param {string} status Status de indexação do documento.
 * @returns {string} Classe CSS: "ok", "info" ou "warn".
 */
export function statusCss(status) {
  const map = { indexado: 'ok', indexando: 'info', aguardando: 'info', erro: 'warn' };
  return map[status] || 'ok';
}

/**
 * Retorna label legível do status de indexação.
 *
 * @param {string} status Status de indexação do documento.
 * @returns {string} Label exibível ao usuário.
 */
export function statusLabel(status) {
  const map = {
    indexado:   'Indexado',
    indexando:  'Indexando',
    aguardando: 'Aguardando indexação',
    erro:       'Falha de indexação',
  };
  return map[status] || 'Indexado';
}

// ── Listagem e contagem ───────────────────────────────────────────────────────

/**
 * Lista documentos lendo diretamente do Cloud Storage.
 * Retorna lista de objetos prontos para serialização JSON, ordenados por
 * data de upload decrescente. Exclui a categoria "legado".
 *
 * @param {string|null} categoria Filtro opcional de categoria (null = todas).
 * @returns {Promise<Array<Object>>} Lista de documentos.
 */
export async function listarDocumentos(categoria = null) {
  initVertex();
  const bucket = storageClient().bucket(bucketName());
  const prefix = categoria ? `documentos/${categoria}/` : 'documentos/';

  const [files] = await bucket.getFiles({ prefix });
  const docs = [];

  for (const file of files) {
    const parts = file.name.split('/');
    // Estrutura esperada: documentos/{categoria}/{id_nome}
    if (parts.length < 3 || !parts[1] || !parts[2]) continue;

    const cat = parts[1];
    if (cat === 'legado') continue; // Documentos arquivados não aparecem na listagem ativa.

    const [metadata] = await file.getMetadata();
    const customMeta = metadata.metadata || {};
    const nome = nomeDoBlobName(file.name, customMeta);
    const tipo = nome.includes('.')
      ? nome.split('.').pop().toLowerCase()
      : 'txt';
    const timeCreated = metadata.timeCreated;
    const dataUpload = timeCreated
      ? new Date(timeCreated).toISOString().slice(0, 16).replace('T', ' ')
      : '';
    const status = statusIndexacaoBlob(customMeta, timeCreated);

    docs.push({
      id:               file.name,
      nome,
      tipo,
      categoria:        cat,
      descricao:        customMeta.descricao || '',
      data_upload:      dataUpload,
      gcs_uri:          `gs://${bucketName()}/${file.name}`,
      status_indexacao: status,
      status_css:       statusCss(status),
      status_label:     statusLabel(status),
    });
  }

  // Ordena por data de upload decrescente.
  return docs.sort((a, b) => b.data_upload.localeCompare(a.data_upload));
}

/**
 * Conta todos os documentos ativos no Cloud Storage (exclui legado/).
 *
 * @returns {Promise<number>} Contagem de documentos ativos.
 */
export async function contarDocumentos() {
  initVertex();
  const bucket = storageClient().bucket(bucketName());
  const [files] = await bucket.getFiles({ prefix: 'documentos/' });
  return files.filter(f => {
    const p = f.name.split('/');
    return p.length >= 3 && p[2] && p[1] !== 'legado';
  }).length;
}

/**
 * Conta documentos de uma categoria específica no Cloud Storage.
 *
 * @param {string} categoria Categoria a contar.
 * @returns {Promise<number>} Contagem de documentos na categoria.
 */
export async function contarDocumentosCategoria(categoria) {
  initVertex();
  const bucket = storageClient().bucket(bucketName());
  const [files] = await bucket.getFiles({ prefix: `documentos/${categoria}/` });
  return files.filter(f => {
    const p = f.name.split('/');
    return p.length >= 3 && p[2];
  }).length;
}

// ── Upload e remoção ──────────────────────────────────────────────────────────

/**
 * Faz upload do arquivo ao GCS e dispara a pipeline de ingestão.
 *
 * Fluxo assíncrono (quando Cloud Tasks está configurado):
 *   1. Upload do arquivo RAW para o GCS.
 *   2. Enfileira uma tarefa HTTP para o worker no Cloud Run.
 *   3. Retorna imediatamente com status "indexando".
 *
 * Fluxo síncrono (fallback sem Cloud Tasks):
 *   1. Upload do arquivo RAW para o GCS.
 *   2. Importa diretamente no Agent Builder (aguarda até 5s).
 *   3. Retorna com status "indexado", "indexando" ou "erro".
 *
 * @param {string} nome          Nome original do arquivo.
 * @param {string} tipo          Extensão do arquivo (pdf, docx, txt).
 * @param {string} categoria     Categoria de conhecimento no Data Store.
 * @param {string} descricao     Descrição opcional do documento.
 * @param {Buffer} conteudoBytes Buffer com bytes do arquivo.
 * @param {string} usuario       Matrícula ou identificador do usuário.
 * @returns {Promise<{blob_name: string, status_indexacao: string}>}
 */
export async function salvarDocumento(nome, tipo, categoria, descricao, conteudoBytes, usuario) {
  initVertex();

  // Sanitiza o nome para prevenir path traversal.
  nome = basename(nome) || 'arquivo';

  const uid = randomUUID().replace(/-/g, '').substring(0, 12);
  const blobName = `documentos/${categoria}/${uid}_${nome}`;
  const gcsUri   = `gs://${bucketName()}/${blobName}`;

  const bucket = storageClient().bucket(bucketName());
  const file = bucket.file(blobName);

  const customMeta = {
    nome_original:    nome,
    descricao:        descricao || '',
    usuario_upload:   usuario,
    categoria,
    status_indexacao: 'aguardando',
    uploaded_at:      new Date().toISOString(),
  };

  await file.save(conteudoBytes, {
    contentType: MIME_TYPES[tipo?.toLowerCase()] || 'application/octet-stream',
    metadata: { metadata: customMeta },
  });

  // ── Tenta fluxo assíncrono via Cloud Tasks ──────────────────────────────────
  const payload = { blob_name: blobName, gcs_uri: gcsUri, nome, categoria, tipo, usuario };
  const despachado = await despacharTarefaProcessamento(payload);
  if (despachado) {
    return { blob_name: blobName, status_indexacao: 'indexando' };
  }

  // ── Fallback síncrono: importa direto no Agent Builder ───────────────────────
  const status = await importarNoAgentBuilder(gcsUri, file, 5);
  return { blob_name: blobName, status_indexacao: status };
}

/**
 * Baixa e retorna os bytes de um blob do Cloud Storage.
 *
 * @param {string} blobName Caminho do blob no GCS.
 * @returns {Promise<Buffer>} Bytes do blob.
 */
export async function baixarBlob(blobName) {
  initVertex();
  const [contents] = await storageClient().bucket(bucketName()).file(blobName).download();
  return contents;
}

/**
 * Salva texto extraído por OCR como arquivo .txt companheiro no GCS.
 * Salvo em documentos/{categoria}/{uuid8}_ocr_{nome_sem_ext}.txt.
 *
 * @param {string} nomeBase            Nome base do arquivo original.
 * @param {string} categoria           Categoria do documento.
 * @param {string} texto               Texto extraído pelo OCR.
 * @param {string} blobNameOriginal    blob_name do PDF original.
 * @returns {Promise<string>} blob_name do arquivo .txt criado.
 */
export async function salvarTextoOcr(nomeBase, categoria, texto, blobNameOriginal) {
  initVertex();
  const nomeSemExt = nomeBase.includes('.')
    ? nomeBase.substring(0, nomeBase.lastIndexOf('.'))
    : nomeBase;
  const uid = randomUUID().replace(/-/g, '').substring(0, 8);
  const blobName = `documentos/${categoria}/${uid}_ocr_${nomeSemExt}.txt`;

  const bucket = storageClient().bucket(bucketName());
  await bucket.file(blobName).save(Buffer.from(texto, 'utf-8'), {
    contentType: 'text/plain',
    metadata: {
      metadata: {
        nome_original:     `ocr_${nomeSemExt}.txt`,
        blob_pdf_original: blobNameOriginal,
        categoria,
        status_indexacao:  'indexando',
        uploaded_at:       new Date().toISOString(),
      },
    },
  });

  logger.info(`Texto OCR salvo: ${blobName} (${texto.length} chars)`);
  return blobName;
}

/**
 * Importa um URI GCS no Agent Builder e atualiza o status do blob_name.
 * O blob_name pode diferir do URI importado (ex.: indexar .txt OCR mas atualizar status do PDF).
 *
 * @param {string} gcsUri      URI do GCS a ser importado no Agent Builder.
 * @param {string} blobName    blob_name cujo metadata de status será atualizado.
 * @param {number} waitTimeout Segundos para aguardar a LRO.
 * @returns {Promise<string>} "indexado" (submissão aceita) ou "erro".
 */
export async function importarGcsParaVertex(gcsUri, blobName, waitTimeout = 5) {
  initVertex();
  const file = storageClient().bucket(bucketName()).file(blobName);
  return importarNoAgentBuilder(gcsUri, file, waitTimeout);
}

/**
 * Remove blob do Cloud Storage e deleta o documento correspondente no Agent Builder.
 *
 * @param {string} blobName blob_name do documento a remover.
 * @returns {Promise<void>}
 */
export async function removerDocumento(blobName) {
  initVertex();
  const bucket_ = bucketName();
  const gcsUri = `gs://${bucket_}/${blobName}`;

  // 1. Remove do Cloud Storage.
  try {
    await storageClient().bucket(bucket_).file(blobName).delete();
  } catch (err) {
    logger.warn(`Erro ao deletar blob do GCS '${blobName}': ${err.message}`);
  }

  // 2. Localiza e deleta do Agent Builder pelo URI do GCS.
  try {
    const deClient = new DocumentServiceClient({
      keyFilename: (await import('./gcpAuth.js')).credentialsPath(),
    });
    const branch = `projects/${await projectId()}/locations/${searchLocation()}/collections/default_collection`
      + `/dataStores/${dataStoreId()}/branches/default_branch`;

    const [documents] = await deClient.listDocuments({ parent: branch });
    let removido = false;
    for (const doc of documents) {
      const docUri = extrairUriDoDocumento(doc);
      if (docUri.trimEnd() === gcsUri.trimEnd()) {
        await deClient.deleteDocument({ name: doc.name });
        logger.info(`Documento removido do Agent Builder: ${doc.name}`);
        removido = true;
        break;
      }
    }
    if (!removido) {
      logger.info(`Documento não encontrado no Agent Builder para blob '${blobName}'`);
    }
  } catch (err) {
    logger.warn(`Erro ao remover documento do Agent Builder '${blobName}': ${err.message}`);
  }
}

/**
 * Move blob para documentos/legado/, preservando o arquivo para auditorias retroativas.
 *
 * Fluxo:
 *   1. Copia o blob para documentos/legado/{uuid8}_{nome_original} com metadata.
 *   2. Deleta o blob original do GCS.
 *   3. Remove do Agent Builder (índice mantém apenas a versão ativa).
 *
 * @param {string} blobName blob_name do documento a arquivar.
 * @returns {Promise<string>} blob_name do arquivo arquivado (em legado/).
 */
export async function arquivarComoLegado(blobName) {
  initVertex();
  const bucket_ = bucketName();
  const bucket = storageClient().bucket(bucket_);
  const sourceFile = bucket.file(blobName);

  const [sourceMeta] = await sourceFile.getMetadata();
  const customMeta = sourceMeta.metadata || {};
  const nomeOriginal = customMeta.nome_original || basename(blobName);
  const uid = randomUUID().replace(/-/g, '').substring(0, 8);
  const legadoBlobName = `documentos/legado/${uid}_${nomeOriginal}`;

  // Copia para legado/ enriquecendo o metadata com dados de arquivamento.
  await sourceFile.copy(bucket.file(legadoBlobName));
  const legadoFile = bucket.file(legadoBlobName);
  await legadoFile.setMetadata({
    metadata: {
      ...customMeta,
      status_indexacao: 'legado',
      arquivado_em:     new Date().toISOString(),
      blob_original:    blobName,
    },
  });
  logger.info(`Blob arquivado: ${blobName} → ${legadoBlobName}`);

  // Remove o blob original do GCS.
  try {
    await sourceFile.delete();
  } catch (err) {
    logger.warn(`Erro ao deletar blob original após arquivamento: ${err.message}`);
  }

  // Remove do Agent Builder — o índice usa somente a versão ativa.
  const gcsUri = `gs://${bucket_}/${blobName}`;
  try {
    const deClient = new DocumentServiceClient({
      keyFilename: (await import('./gcpAuth.js')).credentialsPath(),
    });
    const branch = `projects/${await projectId()}/locations/${searchLocation()}/collections/default_collection`
      + `/dataStores/${dataStoreId()}/branches/default_branch`;
    const [documents] = await deClient.listDocuments({ parent: branch });
    for (const doc of documents) {
      const docUri = extrairUriDoDocumento(doc);
      if (docUri.trimEnd() === gcsUri.trimEnd()) {
        await deClient.deleteDocument({ name: doc.name });
        logger.info(`Versão anterior removida do Agent Builder: ${doc.name}`);
        break;
      }
    }
  } catch (err) {
    logger.warn(`Erro ao remover versão anterior do Agent Builder: ${err.message}`);
  }

  return legadoBlobName;
}

// ── Helpers privados ──────────────────────────────────────────────────────────

/**
 * Dispara import_documents no Agent Builder e atualiza o metadata de status no arquivo.
 *
 * @param {string} gcsUri      URI do GCS a importar.
 * @param {File}   file        Objeto File do @google-cloud/storage para atualizar metadata.
 * @param {number} waitTimeout Segundos para aguardar a LRO.
 * @returns {Promise<string>} "indexado" ou "erro".
 */
async function importarNoAgentBuilder(gcsUri, file, waitTimeout) {
  try {
    const deClient = new DocumentServiceClient({
      keyFilename: (await import('./gcpAuth.js')).credentialsPath(),
    });
    const parent = `projects/${await projectId()}/locations/${searchLocation()}/collections/default_collection`
      + `/dataStores/${dataStoreId()}/branches/default_branch`;

    const [operation] = await deClient.importDocuments({
      parent,
      gcsSource: { inputUris: [gcsUri], dataSchema: 'content' },
      reconciliationMode: 'INCREMENTAL',
    });

    // Aguarda até waitTimeout pela LRO; mesmo que em andamento, a API aceitou a ingestão.
    try {
      await Promise.race([
        operation.promise(),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('timeout')), waitTimeout * 1000)
        ),
      ]);
    } catch (_) {
      // Timeout esperado — a LRO pode continuar em background.
    }

    const [meta] = await file.getMetadata();
    await file.setMetadata({
      metadata: { ...(meta.metadata || {}), status_indexacao: 'indexado' },
    });
    return 'indexado';
  } catch (err) {
    logger.warn(`Erro ao disparar ingestão no Agent Builder: ${err.message}`);
    try {
      const [meta] = await file.getMetadata();
      await file.setMetadata({
        metadata: { ...(meta.metadata || {}), status_indexacao: 'erro' },
      });
    } catch (_) { /* ignora erro no metadata */ }
    return 'erro';
  }
}

/** Extrai o URI GCS de um Document do Agent Builder. */
function extrairUriDoDocumento(doc) {
  if (doc.content?.uri) return doc.content.uri;
  if (doc.derivedStructData?.link) return String(doc.derivedStructData.link);
  return '';
}
