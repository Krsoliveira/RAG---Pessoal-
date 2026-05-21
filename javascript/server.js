import 'dotenv/config';
import express from 'express';
import multer from 'multer';
import path from 'path';
import { fileURLToPath } from 'url';

import logger from './src/logger.js';
import { getGcpConfig } from './src/gcpAuth.js';
import { uploadToStorage, listarDocumentos } from './src/storageClient.js';
import { despacharTarefaProcessamento } from './src/tasksClient.js';
import { processarPayloadIngestao } from './src/ingestPipeline.js';
import { buscarContextoInteligente } from './src/vertexSearch.js';
import { retrieveContext } from './src/queryOrchestrator.js';
import { gerarToken } from './src/gcpAuth.js';
import { INGEST, SERVER } from './src/config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
app.use(express.json());

// ─── Upload config ────────────────────────────────────────────────────────────

const storage = multer.memoryStorage();
const upload = multer({
  storage,
  limits: { fileSize: INGEST.MAX_FILE_SIZE_BYTES },
  fileFilter: (_req, file, cb) => {
    if (INGEST.ALLOWED_MIME_TYPES.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error(`Tipo de arquivo não suportado: ${file.mimetype}. Use PDF, DOCX ou TXT.`));
    }
  },
});

// ─── Routes ───────────────────────────────────────────────────────────────────

app.get('/', (_req, res) => {
  res.sendFile(path.join(__dirname, '..', 'widget.html'));
});

/**
 * GET /api/token
 * Retorna um token OAuth 2.0 para autenticar o widget no Vertex AI Search.
 */
app.get('/api/token', async (_req, res) => {
  try {
    const token = await gerarToken();
    res.json({ token });
  } catch (err) {
    logger.error('Erro ao gerar token:', err);
    res.status(500).json({ error: 'Falha ao gerar token de autenticação.' });
  }
});

/**
 * POST /api/upload
 * Recebe um documento, faz upload no GCS e enfileira para indexação.
 * Body: multipart/form-data — campo "file" + campo opcional "categoria"
 */
app.post('/api/upload', upload.single('file'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'Nenhum arquivo enviado.' });
  }

  const categoria = req.body?.categoria?.trim() || 'geral';
  const { originalname, mimetype, buffer } = req.file;

  logger.info(`Upload recebido: ${originalname} (${mimetype}) — categoria: ${categoria}`);

  try {
    const gcsPath = await uploadToStorage(buffer, originalname, mimetype, categoria);

    const payload = { gcsPath, nomeOriginal: originalname, mimetype, categoria };

    // Em produção usa Cloud Tasks; localmente processa de forma síncrona
    if (process.env.RAG_INGEST_WORKER_URL) {
      await despacharTarefaProcessamento(payload);
      res.json({ message: 'Documento recebido e enfileirado para indexação.', gcsPath });
    } else {
      await processarPayloadIngestao(payload);
      res.json({ message: 'Documento indexado com sucesso.', gcsPath });
    }
  } catch (err) {
    logger.error('Erro no upload:', err);
    res.status(500).json({ error: err.message || 'Erro ao processar o documento.' });
  }
});

/**
 * POST /api/search
 * Busca semântica direta no Vertex AI Agent Builder.
 * Body: { query: string, categoria?: string }
 */
app.post('/api/search', async (req, res) => {
  const { query, categoria } = req.body ?? {};

  if (!query || typeof query !== 'string' || query.trim().length === 0) {
    return res.status(400).json({ error: 'O campo "query" é obrigatório.' });
  }

  try {
    const resultados = await buscarContextoInteligente(query.trim(), categoria);
    res.json({ resultados });
  } catch (err) {
    logger.error('Erro na busca:', err);
    res.status(500).json({ error: 'Erro ao realizar a busca.' });
  }
});

/**
 * POST /api/chat
 * Pipeline RAG completo: busca contexto + gera resposta via Gemini.
 * Body: { query: string, userId?: string, categoria?: string }
 */
app.post('/api/chat', async (req, res) => {
  const { query, userId = 'anonimo', categoria } = req.body ?? {};

  if (!query || typeof query !== 'string' || query.trim().length === 0) {
    return res.status(400).json({ error: 'O campo "query" é obrigatório.' });
  }

  try {
    const resposta = await retrieveContext(query.trim(), userId, categoria);
    res.json({ resposta });
  } catch (err) {
    logger.error('Erro no chat:', err);
    res.status(500).json({ error: 'Erro ao processar a consulta.' });
  }
});

/**
 * GET /api/documentos
 * Lista os documentos indexados no GCS com seus metadados.
 */
app.get('/api/documentos', async (_req, res) => {
  try {
    const documentos = await listarDocumentos();
    res.json({ documentos });
  } catch (err) {
    logger.error('Erro ao listar documentos:', err);
    res.status(500).json({ error: 'Erro ao listar documentos.' });
  }
});

// ─── Error handler ────────────────────────────────────────────────────────────

app.use((err, _req, res, _next) => {
  if (err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE') {
    return res.status(413).json({ error: 'Arquivo muito grande. Limite: 50 MB.' });
  }
  logger.error('Erro não tratado:', err);
  res.status(500).json({ error: err.message || 'Erro interno.' });
});

// ─── Start ────────────────────────────────────────────────────────────────────

const PORT = Number(process.env.PORT) || SERVER.DEFAULT_PORT;

app.listen(PORT, () => {
  logger.info(`Servidor iniciado em http://localhost:${PORT}`);
  logger.info(`Projeto GCP: ${getGcpConfig().projectId}`);
});
