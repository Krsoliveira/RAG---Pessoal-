import 'dotenv/config';
import express from 'express';
import multer from 'multer';
import path from 'path';
import { fileURLToPath } from 'url';

import logger from './src/logger.js';
import { credentials, projectId } from './src/gcpAuth.js';
import { salvarDocumento, listarDocumentos } from './src/storageClient.js';
import { buscarContextoInteligente } from './src/vertexSearch.js';
import { retrieveContext, shouldBlockAnswer } from './src/queryOrchestrator.js';
import { gerarRespostaGemini } from './src/geminiService.js';
import { INGEST, SERVER } from './src/config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
app.use(express.json());

// ─── Upload config ────────────────────────────────────────────────────────────

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: INGEST.MAX_FILE_SIZE_BYTES },
  fileFilter: (_req, file, cb) => {
    if (INGEST.ALLOWED_MIME_TYPES.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error(`Tipo não suportado: ${file.mimetype}. Use PDF, DOCX ou TXT.`));
    }
  },
});

// ─── Routes ───────────────────────────────────────────────────────────────────

app.get('/', (_req, res) => {
  res.sendFile(path.join(__dirname, '..', 'widget.html'));
});

/**
 * GET /api/token
 * Retorna access token OAuth 2.0 para autenticar o widget no Vertex AI Search.
 */
app.get('/api/token', async (_req, res) => {
  try {
    const authClient = credentials();
    const { token } = await authClient.getAccessToken();
    res.json({ token });
  } catch (err) {
    logger.error('Erro ao gerar token:', err);
    res.status(500).json({ error: 'Falha ao gerar token de autenticação.' });
  }
});

/**
 * POST /api/upload
 * Recebe um documento, faz upload no GCS e dispara a pipeline de ingestão.
 * Body: multipart/form-data
 *   - file      : arquivo (PDF, DOCX, TXT)
 *   - categoria : string (padrão: "geral")
 *   - descricao : string (opcional)
 *   - usuario   : string (padrão: "anonimo")
 */
app.post('/api/upload', upload.single('arquivo'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ erro: 'Nenhum arquivo enviado.' });
  }

  const { originalname, mimetype, buffer } = req.file;
  const categoria = req.body?.categoria?.trim() || 'geral';
  const descricao = req.body?.descricao?.trim() || '';
  const usuario   = req.body?.usuario?.trim()   || 'anonimo';

  // Extrai a extensão sem o ponto (pdf, docx, txt)
  const tipo = originalname.includes('.')
    ? originalname.split('.').pop().toLowerCase()
    : mimetype.split('/').pop();

  logger.info(`Upload: ${originalname} (${tipo}) — categoria: ${categoria} — usuario: ${usuario}`);

  try {
    const resultado = await salvarDocumento(originalname, tipo, categoria, descricao, buffer, usuario);
    res.json({
      mensagem:          'Documento recebido e enfileirado para indexação.',
      blob_name:         resultado.blob_name,
      status_indexacao:  resultado.status_indexacao,
    });
  } catch (err) {
    logger.error('Erro no upload:', err);
    res.status(500).json({ erro: err.message || 'Erro ao processar o documento.' });
  }
});

/**
 * POST /api/search
 * Busca semântica direta no Vertex AI Agent Builder.
 * Body: { query: string, categoria?: string, topK?: number }
 */
app.post('/api/search', async (req, res) => {
  const { query, categoria, topK = 10 } = req.body ?? {};

  if (!query || typeof query !== 'string' || !query.trim()) {
    return res.status(400).json({ erro: 'O campo "query" é obrigatório.' });
  }

  try {
    const resultados = await buscarContextoInteligente(query.trim(), categoria ?? null, topK);
    res.json({ resultados });
  } catch (err) {
    logger.error('Erro na busca:', err);
    res.status(500).json({ erro: 'Erro ao realizar a busca.' });
  }
});

/**
 * POST /api/chat
 * Pipeline RAG completo: recupera contexto, bloqueia se vazio e chama Gemini para gerar resposta HTML.
 * Body: { pergunta: string, categoria?: string, topK?: number }
 */
app.post('/api/chat', async (req, res) => {
  const { pergunta, categoria, topK = 10 } = req.body ?? {};

  if (!pergunta || typeof pergunta !== 'string' || !pergunta.trim()) {
    return res.status(400).json({ erro: 'O campo "pergunta" é obrigatório.' });
  }

  try {
    const { docs } = await retrieveContext(pergunta.trim(), categoria ?? null, topK);

    const gate = shouldBlockAnswer(docs, pergunta);
    if (gate.bloqueado) {
      return res.json({
        resposta_html: `<p>${gate.mensagem}</p>`,
        fontes: [],
      });
    }

    const respostaHtml = await gerarRespostaGemini(pergunta.trim(), docs);

    res.json({
      resposta_html: respostaHtml,
      fontes: docs.map(d => ({ nome: d.nome, uri: d.uri, score: d.score })),
    });
  } catch (err) {
    logger.error('Erro no chat:', err);
    res.status(500).json({ erro: 'Erro ao processar a consulta.' });
  }
});

/**
 * GET /api/documentos
 * Lista os documentos indexados no GCS com seus metadados.
 * Query: ?categoria=auditoria (opcional)
 */
app.get('/api/documentos', async (req, res) => {
  const categoria = req.query.categoria?.trim() || null;
  try {
    const documentos = await listarDocumentos(categoria);
    res.json({ documentos, total: documentos.length });
  } catch (err) {
    logger.error('Erro ao listar documentos:', err);
    res.status(500).json({ erro: 'Erro ao listar documentos.' });
  }
});

// ─── Error handler ────────────────────────────────────────────────────────────

app.use((err, _req, res, _next) => {
  if (err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE') {
    return res.status(413).json({ erro: 'Arquivo muito grande. Limite: 50 MB.' });
  }
  logger.error('Erro não tratado:', err);
  res.status(500).json({ erro: err.message || 'Erro interno.' });
});

// ─── Start ────────────────────────────────────────────────────────────────────

const PORT = Number(process.env.PORT) || SERVER.DEFAULT_PORT;

app.listen(PORT, () => {
  logger.info(`Servidor iniciado em http://localhost:${PORT}`);
  try {
    logger.info(`Projeto GCP: ${projectId()}`);
  } catch {
    logger.warn('Projeto GCP: não foi possível ler o project_id das credenciais.');
  }
});
