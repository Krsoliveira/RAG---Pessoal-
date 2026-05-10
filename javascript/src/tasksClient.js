/**
 * Despacho de ingestão assíncrona via Google Cloud Tasks.
 *
 * Responsabilidade: enfileirar chamadas HTTP autenticadas (OIDC) para o endpoint
 * worker no Cloud Run, enviando payload JSON puro.
 *
 * Espelha: ai_agents/services/tasks_client.py
 *
 * Configuração via variáveis de ambiente:
 *   RAG_INGEST_TASKS_QUEUE                 — nome da fila Cloud Tasks
 *   RAG_INGEST_TASKS_LOCATION              — região da fila (ex.: us-central1)
 *   RAG_INGEST_WORKER_URL                  — URL do endpoint worker (Cloud Run)
 *   RAG_INGEST_TASKS_SERVICE_ACCOUNT_EMAIL — SA para OIDC token
 */

import { CloudTasksClient } from '@google-cloud/tasks';
import { initVertex, projectId, credentialsPath } from './gcpAuth.js';
import logger from './logger.js';

/**
 * Cria uma tarefa HTTP no Cloud Tasks para processar um documento.
 *
 * A tarefa autentica o worker via token OIDC gerado pela conta de serviço
 * configurada em RAG_INGEST_TASKS_SERVICE_ACCOUNT_EMAIL.
 *
 * Retorna false sem logar erro se RAG_INGEST_WORKER_URL não estiver configurado
 * — comportamento esperado em desenvolvimento local.
 *
 * @param {Object} dadosDocumento Objeto com: blob_name, gcs_uri, nome, categoria, tipo, usuario.
 * @returns {Promise<boolean>} true se a tarefa foi criada; false caso contrário.
 */
export async function despacharTarefaProcessamento(dadosDocumento) {
  const queueName           = (process.env.RAG_INGEST_TASKS_QUEUE || '').trim();
  const location            = (process.env.RAG_INGEST_TASKS_LOCATION || '').trim();
  const workerUrl           = (process.env.RAG_INGEST_WORKER_URL || '').trim();
  const serviceAccountEmail = (process.env.RAG_INGEST_TASKS_SERVICE_ACCOUNT_EMAIL || '').trim();

  // Sem URL do worker: ingestão síncrona em dev/local (comportamento esperado).
  if (!workerUrl) {
    logger.debug(
      'RAG_INGEST_WORKER_URL vazio — Cloud Tasks desligado; fallback síncrono. '
      + 'Em produção Cloud Run defina esta variável.'
    );
    return false;
  }

  if (!queueName || !location || !serviceAccountEmail) {
    logger.warn(
      `Cloud Tasks incompleta: com worker_url definido, faltam fila/região/SA. `
      + `queue=${!!queueName} location=${!!location} sa=${!!serviceAccountEmail}`
    );
    return false;
  }

  // Enriquece o payload com a data de publicação.
  const payload = {
    ...dadosDocumento,
    publicado_em: dadosDocumento.publicado_em || new Date().toISOString(),
  };

  try {
    initVertex();
    const pid = projectId();

    const client = new CloudTasksClient({ keyFilename: credentialsPath() });
    const parent = client.queuePath(pid, location, queueName);

    const payloadBuffer = Buffer.from(JSON.stringify(payload), 'utf-8');

    const [task] = await client.createTask({
      parent,
      task: {
        httpRequest: {
          httpMethod: 'POST',
          url: workerUrl,
          headers: { 'Content-Type': 'application/json' },
          body: payloadBuffer,
          oidcToken: {
            serviceAccountEmail,
            audience: workerUrl,
          },
        },
      },
    });

    logger.info(`Tarefa de ingestão criada no Cloud Tasks: ${task.name}`);
    return true;
  } catch (err) {
    logger.error(`Erro ao criar tarefa no Cloud Tasks: ${err.message}`);
    return false;
  }
}
