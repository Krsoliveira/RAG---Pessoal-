/**
 * Pipeline compartilhado de ingestão de documentos.
 *
 * Usado por:
 *   - Worker HTTP (Cloud Tasks)
 *   - Fallback síncrono (quando Cloud Tasks não está configurado)
 *
 * Espelha: ai_agents/services/ingest_pipeline.py
 *
 * Depende de: gcpAuth, storageClient, documentAiService
 */

import { initVertex, bucketName, storageClient } from './gcpAuth.js';
import {
  baixarBlob,
  importarGcsParaVertex,
  salvarTextoOcr,
} from './storageClient.js';
import { pdfTemTextoExtraivel, extrairTextoPdf } from './documentAiService.js';
import logger from './logger.js';

// ── Erros de negócio ──────────────────────────────────────────────────────────

/**
 * Erro de negócio/configuração que não deve ser reprocessado.
 * Ao receber este erro, o worker deve confirmar (ACK) a tarefa.
 */
export class IngestIrrecoverableError extends Error {
  constructor(message) {
    super(message);
    this.name = 'IngestIrrecoverableError';
  }
}

/**
 * Erro transitório de infraestrutura que pode ser reprocessado.
 * Ao receber este erro, o worker deve negar (NACK) a tarefa.
 */
export class IngestRecoverableError extends Error {
  constructor(message, cause) {
    super(message);
    this.name  = 'IngestRecoverableError';
    this.cause = cause;
  }
}

// ── Pipeline principal ────────────────────────────────────────────────────────

/**
 * Executa o pipeline completo de ingestão para um payload JSON.
 *
 * Fluxo:
 *   1. Valida blob_name e gcs_uri no payload.
 *   2. Verifica duplicata (blob já indexado/indexando → ignora).
 *   3. Marca blob como "indexando".
 *   4. Baixa bytes do blob.
 *   5. Se PDF sem texto → OCR via Document AI → salva .txt auxiliar.
 *   6. Importa no Agent Builder (aguarda até 120s pela LRO).
 *   7. Atualiza metadata OCR no blob original se aplicável.
 *
 * @param {Object} dados Objeto com: blob_name, gcs_uri, nome, categoria, tipo.
 * @returns {Promise<{status: string, duplicata: boolean, ocr_realizado: boolean, ocr_blob_name: string|null}>}
 * @throws {IngestIrrecoverableError} Se o payload for inválido ou o blob não existir.
 * @throws {IngestRecoverableError}   Se houver erro transitório de infraestrutura.
 */
export async function processarPayloadIngestao(dados) {
  const blobName  = (dados.blob_name || '').trim();
  const gcsUri    = (dados.gcs_uri   || '').trim();
  let   nome      = (dados.nome      || '').trim();
  let   categoria = (dados.categoria || 'geral').trim() || 'geral';
  const tipo      = (dados.tipo      || '').toLowerCase().trim();

  if (!nome && blobName) nome = blobName.split('/').pop();

  if (!blobName || !gcsUri) {
    throw new IngestIrrecoverableError('Payload incompleto (blob_name/gcs_uri ausentes).');
  }

  try {
    initVertex();
    const bucket = storageClient().bucket(bucketName());

    // 1. Verifica duplicata.
    const blobFile = bucket.file(blobName);
    const [exists] = await blobFile.exists();
    if (!exists) {
      throw new IngestIrrecoverableError(`Blob inexistente no GCS: ${blobName}`);
    }

    try {
      const [meta] = await blobFile.getMetadata();
      const statusAtual = (meta.metadata?.status_indexacao || '').trim();
      if (statusAtual === 'indexando' || statusAtual === 'indexado') {
        logger.info(`Duplicata ignorada: '${nome}' status=${statusAtual}`);
        return { status: statusAtual, duplicata: true, ocr_realizado: false, ocr_blob_name: null };
      }
    } catch (err) {
      logger.warn(`Falha na leitura de metadata para '${blobName}': ${err.message}`);
    }

    // 2. Pré-marca como indexando.
    try {
      const [metaAtual] = await blobFile.getMetadata();
      await blobFile.setMetadata({
        metadata: { ...(metaAtual.metadata || {}), status_indexacao: 'indexando' },
      });
    } catch (err) {
      logger.warn(`Não foi possível pré-marcar '${blobName}' como indexando: ${err.message}`);
    }

    // 3. Baixa os bytes.
    const conteudoBytes = await baixarBlob(blobName);
    let gcsUriParaIndexar = gcsUri;
    let ocrRealizado      = false;
    let ocrBlobName       = null;

    // 4. OCR se PDF sem camada de texto.
    if (tipo === 'pdf' && !(await pdfTemTextoExtraivel(conteudoBytes))) {
      const textoOcr = await extrairTextoPdf(conteudoBytes);
      if (textoOcr.trim()) {
        const nomeBaseSemExt = nome.includes('.')
          ? nome.substring(0, nome.lastIndexOf('.'))
          : nome;
        ocrBlobName = await salvarTextoOcr(nomeBaseSemExt, categoria, textoOcr, blobName);
        gcsUriParaIndexar = `gs://${bucketName()}/${ocrBlobName}`;
        ocrRealizado = true;
      }
    }

    // 5. Importa no Agent Builder.
    // No worker assíncrono, vale aguardar mais para persistir o status "indexado".
    const status = await importarGcsParaVertex(gcsUriParaIndexar, blobName, 120);

    // 6. Atualiza metadata OCR no blob original.
    if (ocrRealizado && ocrBlobName) {
      await _atualizarMetadataOcr(blobName, ocrBlobName, blobFile);
    }

    return { status, duplicata: false, ocr_realizado: ocrRealizado, ocr_blob_name: ocrBlobName };

  } catch (err) {
    if (err instanceof IngestIrrecoverableError) {
      await _marcarBlobErro(blobName, err.message);
      throw err;
    }
    if (err.code === 404 || err.message?.includes('not found')) {
      const msg = String(err.message);
      await _marcarBlobErro(blobName, msg);
      throw new IngestIrrecoverableError(msg);
    }
    if (err instanceof TypeError || err instanceof RangeError) {
      const msg = String(err.message);
      await _marcarBlobErro(blobName, msg);
      throw new IngestIrrecoverableError(msg);
    }
    throw new IngestRecoverableError(String(err.message), err);
  }
}

// ── Helpers privados ──────────────────────────────────────────────────────────

/** Marca o blob com status_indexacao=erro e registra o motivo. */
async function _marcarBlobErro(blobName, motivo) {
  try {
    const file = storageClient().bucket(bucketName()).file(blobName);
    const [meta] = await file.getMetadata();
    await file.setMetadata({
      metadata: {
        ...(meta.metadata || {}),
        status_indexacao: 'erro',
        erro_motivo: (motivo || '').substring(0, 200),
        erro_em:     new Date().toISOString(),
      },
    });
  } catch (err) {
    logger.warn(`Não foi possível marcar blob como erro '${blobName}': ${err.message}`);
  }
}

/** Atualiza o metadata do blob original com informações do OCR realizado. */
async function _atualizarMetadataOcr(blobName, ocrBlobName, blobFile) {
  try {
    const [meta] = await blobFile.getMetadata();
    await blobFile.setMetadata({
      metadata: {
        ...(meta.metadata || {}),
        ocr_realizado: 'true',
        ocr_blob:      ocrBlobName,
        ocr_em:        new Date().toISOString(),
      },
    });
  } catch (err) {
    logger.warn(`Não foi possível atualizar metadata OCR para '${blobName}': ${err.message}`);
  }
}
