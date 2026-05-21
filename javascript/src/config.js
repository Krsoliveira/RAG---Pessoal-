/**
 * Configurações centralizadas da aplicação.
 * Valores hardcoded devem vir daqui — nunca espalhados pelo código.
 */

export const INGEST = {
  /** Timeout máximo para indexação no Vertex AI Agent Builder (ms) */
  TIMEOUT_MS: 120_000,
  /** Tipos MIME aceitos para upload */
  ALLOWED_MIME_TYPES: ['application/pdf', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'text/plain'],
  /** Extensões aceitas (alinhadas com ALLOWED_MIME_TYPES) */
  ALLOWED_EXTENSIONS: ['.pdf', '.docx', '.txt'],
  /** Tamanho máximo de arquivo em bytes (50 MB) */
  MAX_FILE_SIZE_BYTES: 50 * 1024 * 1024,
};

export const DOCUMENT_AI = {
  /** Máximo de páginas suportadas pelo Document AI por requisição */
  MAX_PAGES: 30,
  /** Número de páginas usadas na heurística de detecção de texto extraível */
  HEURISTIC_PAGES: 5,
};

export const MEMORY = {
  /** Tamanho máximo do histórico de conversa por usuário (entradas) */
  HISTORY_WINDOW: 200,
  /** Intervalo de consultas para regeneração do perfil do usuário */
  PROFILE_REGEN_INTERVAL: 5,
};

export const SEARCH = {
  /** Máximo de trechos por documento nos resultados de busca */
  MAX_EXCERPTS_PER_DOC: 2,
};

export const SERVER = {
  /** Porta padrão do servidor Express */
  DEFAULT_PORT: 3000,
};
