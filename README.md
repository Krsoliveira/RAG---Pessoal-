# RAG com Google Cloud Vertex AI

Sistema de **Retrieval-Augmented Generation (RAG)** integrado ao Google Cloud Platform.  
Permite fazer upload de documentos (PDF, DOCX, TXT), indexá-los automaticamente no **Vertex AI Agent Builder** e consultá-los em linguagem natural via busca semântica.

---

## Demonstração

> Interface web para upload, busca semântica e listagem de documentos indexados.

![Interface RAG](https://via.placeholder.com/800x400?text=Print+da+interface+aqui)

---

## Arquitetura

```
┌─────────────────────────────────────────────────────────┐
│                     Usuário (Browser)                   │
│              widget.html  ←→  API REST                  │
└───────────────────────┬─────────────────────────────────┘
                        │ HTTP
┌───────────────────────▼─────────────────────────────────┐
│              Servidor Node.js (Express)                  │
│                                                          │
│  POST /api/upload    → storageClient → gcpAuth          │
│  POST /api/search    → vertexSearch  → gcpAuth          │
│  GET  /api/documentos → storageClient                   │
│  GET  /api/token     → OAuth 2.0 (GoogleAuth)           │
└──────────┬────────────────────────┬─────────────────────┘
           │                        │
┌──────────▼──────────┐  ┌──────────▼──────────────────┐
│  Cloud Storage      │  │  Vertex AI Agent Builder     │
│  (armazenamento     │  │  (indexação + busca          │
│   dos documentos)   │  │   semântica RAG)             │
└─────────────────────┘  └─────────────────────────────┘
```

---

## Stack

| Camada | Tecnologia |
|---|---|
| Backend | Node.js 20+ · Express · ES Modules |
| Autenticação GCP | google-auth-library · Service Account |
| Armazenamento | Google Cloud Storage |
| Busca semântica | Vertex AI Agent Builder (Discovery Engine) |
| Upload | Multer (PDF · DOCX · TXT — até 50 MB) |
| Frontend | HTML · CSS · JavaScript vanilla · `<gen-search-widget>` |

---

## Funcionalidades

- Upload de documentos PDF, DOCX e TXT com categorização
- Indexação automática no Vertex AI Agent Builder após o upload
- Busca semântica em linguagem natural sobre os documentos indexados
- Widget oficial do Google (`<gen-search-widget>`) integrado à interface
- Listagem de documentos com status de indexação
- Filtro de busca por categoria

---

## Pré-requisitos

- [Node.js 20+](https://nodejs.org/)
- Projeto no [Google Cloud Platform](https://console.cloud.google.com/) com os seguintes serviços habilitados:
  - Cloud Storage
  - Vertex AI Agent Builder (Discovery Engine)
- Service Account com permissões nos serviços acima
- Arquivo JSON de credenciais da Service Account

---

## Como rodar localmente

**1. Clone o repositório**
```bash
git clone https://github.com/Krsoliveira/RAG---Pessoal-.git
cd RAG---Pessoal-
```

**2. Configure as variáveis de ambiente**

Crie um arquivo `.env` na raiz com base no exemplo abaixo:
```env
GCP_VERTEX_CREDENTIALS_PATH=./credentials_rag.json
GCP_STORAGE_BUCKET=nome-do-seu-bucket
GCP_VERTEX_DATA_STORE_ID=id-do-seu-data-store
GCP_VERTEX_SEARCH_LOCATION=global
GCP_VERTEX_LOCATION=us-central1
GCP_VERTEX_GEMINI_FLASH_MODEL=gemini-2.5-flash
```

**3. Coloque o JSON de credenciais na raiz**
```
RAG---Pessoal-/
├── credentials_rag.json   ← arquivo da Service Account (NÃO versionar)
├── .env                   ← variáveis de ambiente (NÃO versionar)
└── ...
```

**4. Inicie o servidor**
```bash
# Windows
start-node.bat

# Manual
cd javascript && npm install && node server.js
```

**5. Acesse no navegador**
```
http://localhost:3000
```

---

## Estrutura do projeto

```
├── javascript/
│   ├── server.js                  # Servidor Express — rotas da API REST
│   └── src/
│       ├── gcpAuth.js             # Configuração e autenticação GCP
│       ├── storageClient.js       # Upload e listagem no Cloud Storage
│       ├── vertexSearch.js        # Busca semântica no Agent Builder
│       ├── ingestPipeline.js      # Pipeline de ingestão de documentos
│       ├── documentAiService.js   # Integração com Document AI
│       ├── queryOrchestrator.js   # Orquestração de consultas RAG
│       ├── memoryManager.js       # Gerenciamento de contexto de conversas
│       ├── tasksClient.js         # Integração com Cloud Tasks
│       └── logger.js              # Logger estruturado
├── java/                          # Implementação alternativa em Java
│   └── src/main/java/br/gov/siai/rag/
├── widget.html                    # Interface web completa
├── start-node.bat                 # Inicializador Windows
└── .env.example                   # Exemplo de configuração
```

---

## API REST

| Método | Rota | Descrição |
|---|---|---|
| `GET` | `/` | Interface web |
| `GET` | `/api/token` | OAuth 2.0 token para o widget |
| `POST` | `/api/upload` | Upload e indexação de documento |
| `POST` | `/api/search` | Busca semântica RAG |
| `GET` | `/api/documentos` | Lista documentos indexados |

### Exemplo — Upload
```bash
curl -X POST http://localhost:3000/api/upload \
  -F "arquivo=@documento.pdf" \
  -F "categoria=juridico" \
  -F "descricao=Contrato de prestação de serviços"
```

### Exemplo — Busca
```bash
curl -X POST http://localhost:3000/api/search \
  -H "Content-Type: application/json" \
  -d '{"pergunta": "quais são as cláusulas de rescisão?", "categoria": "juridico", "topK": 5}'
```

---

## Roadmap

- [ ] Autenticação de usuários (login/logout)
- [ ] Histórico de conversas por usuário
- [ ] Deploy em Cloud Run com CI/CD via GitHub Actions
- [ ] Geração de resposta com Gemini (contexto RAG → LLM → resposta)
- [ ] Suporte a mais formatos (XLSX, imagens com OCR)
- [ ] Testes automatizados

---

## Segurança

O arquivo `credentials_rag.json` e o `.env` estão listados no `.gitignore` e **nunca são versionados**. Nunca compartilhe esses arquivos publicamente.

---

## Licença

Projeto pessoal para fins de estudo e portfólio.