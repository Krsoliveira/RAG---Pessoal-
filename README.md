# RAG Pessoal — Busca Semântica em Documentos com IA

![Node.js](https://img.shields.io/badge/Node.js-20+-339933?style=flat-square&logo=node.js&logoColor=white)
![Express](https://img.shields.io/badge/Express-4.x-000000?style=flat-square&logo=express&logoColor=white)
![Google Cloud](https://img.shields.io/badge/Google_Cloud-Vertex_AI-4285F4?style=flat-square&logo=googlecloud&logoColor=white)
![Gemini](https://img.shields.io/badge/Gemini-API-8E75B2?style=flat-square&logo=google&logoColor=white)
![License](https://img.shields.io/badge/licença-MIT-green?style=flat-square)

Sistema de **Retrieval-Augmented Generation (RAG)** para análise e busca semântica em documentos pessoais. Faça upload de PDFs, DOCXs e TXTs e interaja com eles via chat inteligente — sem compartilhar seus dados com terceiros.

---

## Demonstração

```
Usuário: Quais foram os achados críticos da auditoria de março?

IA: Com base nos documentos indexados, os achados críticos de março incluem:
    1. Divergência de R$ 12.400 no fluxo de caixa (Relatório 2025.003)
    2. Ausência de POPs assinados em 3 setores (Evidência E-007)
    3. Prazo de resposta excedido em 45 dias (Achado A-012)
```

---

## Funcionalidades

- **Upload multi-formato** — PDF, DOCX e TXT (até 50 MB por arquivo)
- **Indexação automática** — documentos processados e indexados no Vertex AI Agent Builder
- **OCR inteligente** — extração de texto em PDFs escaneados via Document AI
- **Busca semântica** — consultas em linguagem natural com filtro por categoria
- **Chat com memória** — contexto de conversa persistido por usuário (janela de 200 turnos)
- **Perfil adaptativo** — sistema aprende o padrão de uso e adapta respostas a cada 5 consultas
- **Ingestão assíncrona** — processamento em fila via Cloud Tasks sem bloquear a UI

---

## Arquitetura

```
┌─────────────────────────────────────────────────────────┐
│                      Cliente (Browser)                   │
│              widget.html  ─  Fetch API                  │
└───────────────────────────┬─────────────────────────────┘
                            │ HTTP REST
┌───────────────────────────▼─────────────────────────────┐
│                   Express Server (Node.js)               │
│                                                          │
│  POST /api/upload   POST /api/chat   POST /api/search   │
│  GET  /api/token    GET  /api/documentos                │
└──────┬──────────────────┬──────────────────┬────────────┘
       │                  │                  │
┌──────▼──────┐  ┌────────▼───────┐  ┌──────▼──────────┐
│  GCS Bucket │  │  Vertex AI     │  │  Cloud Tasks     │
│  (arquivos) │  │  Agent Builder │  │  (fila async)    │
└─────────────┘  │  + Gemini API  │  └─────────────────┘
                 └────────┬───────┘
                          │
                 ┌────────▼───────┐
                 │  Document AI   │
                 │  (OCR PDFs)    │
                 └────────────────┘
```

### Módulos internos

| Módulo | Responsabilidade |
|---|---|
| `server.js` | Roteamento HTTP, validação de entrada, orquestração |
| `src/gcpAuth.js` | Credenciais e configuração centralizada do GCP |
| `src/storageClient.js` | Operações no Cloud Storage (upload, leitura, metadados) |
| `src/vertexSearch.js` | Busca semântica no Vertex AI Agent Builder |
| `src/ingestPipeline.js` | Pipeline de ingestão com deduplicação e OCR condicional |
| `src/documentAiService.js` | OCR de PDFs via Google Document AI |
| `src/queryOrchestrator.js` | Orquestração de queries + policy gate de relevância |
| `src/memoryManager.js` | Histórico de conversas e perfil adaptativo por usuário |
| `src/tasksClient.js` | Despacho assíncrono de tarefas via Cloud Tasks |
| `src/logger.js` | Logger centralizado (Winston) |

---

## Pré-requisitos

- **Node.js** 20+
- **Conta GCP** com os serviços habilitados:
  - Cloud Storage
  - Vertex AI Agent Builder (Discovery Engine)
  - Document AI
  - Cloud Tasks
  - Vertex AI (Gemini API)
- **Service Account** com os papéis:
  - `Storage Object Admin`
  - `Discovery Engine Editor`
  - `Document AI Editor`
  - `Cloud Tasks Enqueuer`
  - `Vertex AI User`

---

## Instalação e execução

### 1. Clone o repositório

```bash
git clone https://github.com/Krsoliveira/RAG---Pessoal-.git
cd RAG---Pessoal-/javascript
```

### 2. Configure as credenciais GCP

Baixe o JSON da sua Service Account no console do GCP e salve na raiz do projeto:

```bash
# Coloque o arquivo na raiz (fora de javascript/)
mv ~/Downloads/minha-service-account.json ../credentials_rag.json
```

### 3. Configure as variáveis de ambiente

```bash
cp .env.example .env
# Edite o .env com os valores do seu projeto GCP
```

### 4. Instale as dependências

```bash
npm install
```

### 5. Inicie o servidor

```bash
# Linux / macOS
node server.js

# Windows
../start-node.bat

# Com porta customizada
../start-node.bat 8080
```

Acesse: **http://localhost:3000**

---

## Variáveis de ambiente

Veja o arquivo [`.env.example`](.env.example) para a lista completa e documentada.

| Variável | Descrição | Obrigatória |
|---|---|---|
| `GCP_VERTEX_CREDENTIALS_PATH` | Caminho para o JSON da Service Account | Sim |
| `GCP_STORAGE_BUCKET` | Nome do bucket no Cloud Storage | Sim |
| `GCP_VERTEX_DATA_STORE_ID` | ID do data store no Vertex AI Agent Builder | Sim |
| `GCP_PROJECT_ID` | ID do projeto GCP (lido automaticamente se omitido) | Não |
| `GCP_LOCATION` | Região do Vertex AI (padrão: `global`) | Não |
| `RAG_INGEST_TASKS_QUEUE` | Nome da fila no Cloud Tasks | Prod |
| `RAG_INGEST_WORKER_URL` | URL do worker Cloud Run para ingestão | Prod |
| `LOG_LEVEL` | Nível de log: `debug`, `info`, `warn`, `error` | Não |
| `PORT` | Porta do servidor (padrão: `3000`) | Não |

---

## Como funciona o RAG

```
Upload de documento
       │
       ▼
┌─────────────────────────────────────┐
│ 1. Validação de tipo e tamanho      │
│ 2. Upload para GCS                  │
│ 3. Verificação de duplicata         │
│ 4. Detecção de texto extraível      │
│    └─ Se não → OCR via Document AI  │
│ 5. Envio ao Vertex AI Agent Builder │
│ 6. Atualização de metadados         │
└─────────────────────────────────────┘
       │
       ▼ (indexado)
Query do usuário
       │
       ▼
┌─────────────────────────────────────┐
│ 1. Busca semântica no Agent Builder │
│ 2. Extração de trechos relevantes   │
│ 3. Policy gate (relevância mínima)  │
│ 4. Geração de resposta via Gemini   │
│ 5. Armazenamento no histórico       │
└─────────────────────────────────────┘
       │
       ▼
Resposta ao usuário
```

---

## Estrutura do projeto

```
RAG---Pessoal-/
├── javascript/
│   ├── server.js              # Entry point do servidor Express
│   ├── package.json
│   ├── .env.example           # Template de variáveis de ambiente
│   └── src/
│       ├── gcpAuth.js         # Autenticação e config GCP
│       ├── storageClient.js   # Cloud Storage
│       ├── vertexSearch.js    # Busca semântica
│       ├── ingestPipeline.js  # Pipeline de ingestão
│       ├── documentAiService.js # OCR via Document AI
│       ├── queryOrchestrator.js # Orquestração de queries
│       ├── memoryManager.js   # Histórico e perfil do usuário
│       ├── tasksClient.js     # Cloud Tasks
│       └── logger.js          # Logger centralizado
├── widget.html                # Interface web
├── start-node.bat             # Script de inicialização (Windows)
├── .gitignore
└── README.md
```

---

## Roadmap

- [ ] Autenticação de usuários (OAuth / JWT)
- [ ] Persistência do histórico de conversas na UI
- [ ] Deploy no Cloud Run com Dockerfile
- [ ] Suporte a múltiplos data stores por usuário
- [ ] Interface de administração de documentos
- [ ] Geração de resumo automático ao indexar

---

## Segurança

> **Nunca** commite o arquivo `credentials_rag.json` ou o `.env` com credenciais reais.
> O `.gitignore` já os exclui, mas verifique antes de qualquer push.

---

## Autor

**Kaique Rafael dos Santos Oliveira**

[![LinkedIn](https://img.shields.io/badge/LinkedIn-Kaique_Rafael-0A66C2?style=flat-square&logo=linkedin)](https://www.linkedin.com/in/kaique-rafael-oliveira-858294166/)
[![GitHub](https://img.shields.io/badge/GitHub-Krsoliveira-181717?style=flat-square&logo=github)](https://github.com/Krsoliveira)
[![WhatsApp](https://img.shields.io/badge/WhatsApp-(64)_9_9291--6969-25D366?style=flat-square&logo=whatsapp)](https://wa.me/5564992916969)
