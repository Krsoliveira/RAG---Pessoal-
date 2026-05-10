/**
 * Servidor RAG — meu-rag-java-2026
 *
 * Rotas:
 *   GET  /                → página principal (widget + formulário de upload)
 *   GET  /api/token       → OAuth 2.0 access token para autenticar o <gen-search-widget>
 *   POST /api/upload      → ingestão de PDF/TXT/DOCX no Cloud Storage + Agent Builder
 *   POST /api/search      → consulta RAG direta ao Vertex AI Search (sem widget)
 *   GET  /api/documentos  → lista documentos indexados no bucket
 *
 * Como rodar:
 *   start-node.bat              (Windows — carrega .env automaticamente)
 *   ./start-node.sh             (Linux/Mac)
 */

// ── Imports — todos no topo (obrigatório em ES modules) ───────────────────────
import express              from 'express';
import multer               from 'multer';
import dotenv               from 'dotenv';
import { fileURLToPath }    from 'url';
import { dirname, join, resolve, isAbsolute } from 'path';
import { GoogleAuth }       from 'google-auth-library';

import { initVertex, credentialsPath, dataStoreId, bucketName } from './src/gcpAuth.js';
import { salvarDocumento, listarDocumentos }                    from './src/storageClient.js';
import { buscarContextoInteligente }                            from './src/vertexSearch.js';

// ── Configuração do ambiente — ANTES de qualquer chamada GCP ─────────────────
//
// __dirname aponta para javascript/; REPO_ROOT é a raiz do repositório.
// Isso é necessário porque o .env usa "./credentials_rag.json" (relativo à raiz),
// mas o processo Node.js é iniciado dentro de javascript/ → o path ficaria errado
// se não fosse resolvido para absoluto aqui.

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');

// 1. Carrega variáveis do .env (raiz do repo).
dotenv.config({ path: join(REPO_ROOT, '.env') });

// 2. Converte GCP_VERTEX_CREDENTIALS_PATH para caminho absoluto.
//    "./credentials_rag.json" → "D:\SIAI - REPO_CLONADO\siai-rag-java-js\credentials_rag.json"
if (process.env.GCP_VERTEX_CREDENTIALS_PATH) {
  const raw = process.env.GCP_VERTEX_CREDENTIALS_PATH.trim();
  if (!isAbsolute(raw)) {
    process.env.GCP_VERTEX_CREDENTIALS_PATH = resolve(REPO_ROOT, raw);
  }
}

// 3. Inicializa GOOGLE_APPLICATION_CREDENTIALS com o caminho resolvido.
initVertex();

// ── Express + Multer ──────────────────────────────────────────────────────────

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Multer: Buffer em memória, limite 50 MB, somente PDF/TXT/DOCX.
const upload = multer({
  storage: multer.memoryStorage(),
  limits:  { fileSize: 50 * 1024 * 1024 },
  fileFilter(_req, file, cb) {
    const ALLOWED = new Set([
      'application/pdf',
      'text/plain',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    ]);
    ALLOWED.has(file.mimetype)
      ? cb(null, true)
      : cb(new Error(`Tipo de arquivo não suportado: ${file.mimetype}`));
  },
}).single('arquivo');

// ── GET / — Página principal (widget HTML) ────────────────────────────────────

app.get('/', (_req, res) => {
  res.sendFile(join(REPO_ROOT, 'widget.html'));
});

// ── GET /api/token — OAuth 2.0 token para o <gen-search-widget> ──────────────
//
// O widget chama esta rota via setAuthTokenCallback() para autenticar requests
// sem expor credenciais no browser. Token tem validade de ~1 hora e é renovado
// automaticamente pelo widget antes de expirar.

app.get('/api/token', async (_req, res) => {
  try {
    const auth = new GoogleAuth({
      keyFile: credentialsPath(),
      scopes:  ['https://www.googleapis.com/auth/cloud-platform'],
    });
    const client = await auth.getClient();
    const { token } = await client.getAccessToken();

    if (!token) throw new Error('Token retornado pelo GoogleAuth está vazio.');

    res.json({ token });
  } catch (err) {
    console.error('[/api/token] Erro:', err.message);
    res.status(500).json({ erro: 'Falha ao gerar token OAuth.', detalhe: err.message });
  }
});

// ── POST /api/upload — Upload para GCS + ingestão no Agent Builder ────────────
//
// Form-data esperado:
//   arquivo    (File)   → PDF, TXT ou DOCX (máx. 50 MB)
//   categoria  (string) → categoria do documento (padrão: "geral")
//   descricao  (string) → descrição opcional
//   usuario    (string) → matrícula ou identificador (padrão: "web_user")
//
// Resposta: { blob_name, status_indexacao, mensagem, bucket, data_store }

app.post('/api/upload', (req, res) => {
  upload(req, res, async (err) => {
    if (err instanceof multer.MulterError) {
      return res.status(400).json({ erro: `Erro de upload: ${err.message}` });
    }
    if (err) {
      return res.status(400).json({ erro: err.message });
    }
    if (!req.file) {
      return res.status(400).json({ erro: 'Nenhum arquivo enviado. Use o campo "arquivo".' });
    }

    const { originalname, buffer, mimetype } = req.file;
    const categoria = (req.body.categoria || 'geral').trim().replace(/[^a-z0-9_-]/gi, '_');
    const descricao = (req.body.descricao || '').trim();
    const usuario   = (req.body.usuario   || 'web_user').trim();

    // Extensão derivada do MIME type (mais seguro que confiar no nome do arquivo).
    const EXT_MAP = {
      'application/pdf':   'pdf',
      'text/plain':        'txt',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
    };
    const tipo = EXT_MAP[mimetype] || 'txt';

    console.log(`[/api/upload] arquivo="${originalname}" tipo=${tipo} cat=${categoria} user=${usuario}`);

    try {
      const resultado = await salvarDocumento(
        originalname, tipo, categoria, descricao, buffer, usuario,
      );

      res.json({
        blob_name:        resultado.blob_name,
        status_indexacao: resultado.status_indexacao,
        mensagem:         `Arquivo "${originalname}" enviado com sucesso.`,
        bucket:           bucketName(),
        data_store:       dataStoreId(),
      });
    } catch (uploadErr) {
      console.error('[/api/upload] Erro:', uploadErr.message);
      res.status(500).json({ erro: 'Falha no upload.', detalhe: uploadErr.message });
    }
  });
});

// ── POST /api/search — Consulta RAG ao Vertex AI Search ──────────────────────
//
// Body JSON: { pergunta: string, categoria?: string, topK?: number }
// Resposta:  { resultados: [{ nome, uri, texto, score }], total: number }

app.post('/api/search', async (req, res) => {
  const { pergunta, categoria = null, topK = 5 } = req.body;

  if (!pergunta || typeof pergunta !== 'string' || !pergunta.trim()) {
    return res.status(400).json({ erro: 'Campo "pergunta" é obrigatório.' });
  }

  console.log(`[/api/search] query="${pergunta.substring(0, 60)}" cat=${categoria || 'todas'} topK=${topK}`);

  try {
    const resultados = await buscarContextoInteligente(
      pergunta.trim(),
      categoria,
      Math.min(Math.max(parseInt(topK, 10) || 5, 1), 20),
    );
    res.json({ resultados, total: resultados.length });
  } catch (err) {
    console.error('[/api/search] Erro:', err.message);
    res.status(500).json({ erro: 'Falha na busca RAG.', detalhe: err.message });
  }
});

// ── GET /api/documentos — Lista documentos do bucket ─────────────────────────
//
// Query params: categoria (opcional)
// Resposta:     { documentos: [...], total: number }

app.get('/api/documentos', async (req, res) => {
  const { categoria = null } = req.query;
  try {
    const documentos = await listarDocumentos(categoria || null);
    res.json({ documentos, total: documentos.length });
  } catch (err) {
    console.error('[/api/documentos] Erro:', err.message);
    res.status(500).json({ erro: 'Falha ao listar documentos.', detalhe: err.message });
  }
});

// ── Erro genérico ─────────────────────────────────────────────────────────────

app.use((err, _req, res, _next) => {
  console.error('[server] Erro não tratado:', err.message);
  res.status(500).json({ erro: 'Erro interno do servidor.' });
});

// ── Start ─────────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  const credPath = process.env.GCP_VERTEX_CREDENTIALS_PATH || '(não configurado)';
  console.log('');
  console.log('╔══════════════════════════════════════════════╗');
  console.log('║   RAG Server — meu-rag-java-2026            ║');
  console.log('╠══════════════════════════════════════════════╣');
  console.log(`║   URL      : http://localhost:${PORT}           ║`);
  console.log(`║   Bucket   : ${(process.env.GCP_STORAGE_BUCKET || '').padEnd(28)} ║`);
  console.log(`║   DataStore: ${dataStoreId().substring(0, 28).padEnd(28)} ║`);
  console.log('╚══════════════════════════════════════════════╝');
  console.log('');
  console.log('  Credenciais:', credPath);
  console.log('');
  console.log('  Rotas disponíveis:');
  console.log('  GET  /                → widget de busca');
  console.log('  GET  /api/token       → OAuth token para o widget');
  console.log('  POST /api/upload      → upload de documento');
  console.log('  POST /api/search      → consulta RAG (JSON)');
  console.log('  GET  /api/documentos  → lista documentos');
  console.log('');
});