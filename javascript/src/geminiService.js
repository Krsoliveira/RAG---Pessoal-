/**
 * Integração com Gemini via Vertex AI.
 *
 * Responsabilidade: receber chunks recuperados + pergunta do usuário e gerar
 * uma resposta estruturada em HTML usando o modelo Gemini Flash.
 *
 * Depende de: gcpAuth
 */

import { GoogleGenAI } from '@google/genai';
import { credentialsPath, projectId } from './gcpAuth.js';
import logger from './logger.js';

const GEMINI_MODEL    = process.env.GCP_VERTEX_GEMINI_FLASH_MODEL || 'gemini-2.5-flash';
const VERTEX_LOCATION = process.env.GCP_VERTEX_LOCATION           || 'us-central1';

// ── Prompt ────────────────────────────────────────────────────────────────────

function buildPrompt(pergunta, chunks) {
  const contexto = chunks
    .map((c, i) => `[Fonte ${i + 1} — ${c.nome}]\n${c.texto}`)
    .join('\n\n---\n\n');

  return `Você é um assistente especializado em análise de documentos institucionais.
Responda à pergunta com base EXCLUSIVAMENTE nos trechos de documentos fornecidos abaixo.

REGRAS OBRIGATÓRIAS:
1. Responda SOMENTE em HTML — sem markdown, sem blocos com backticks
2. Use tags semânticas: <p>, <ul>, <ol>, <li>, <strong>, <em>, <code>, <h3>, <h4>
3. Para dados tabulares, use <table> com <thead> e <tbody>
4. Se a informação não estiver nos trechos, informe isso claramente dentro de um <p>
5. Ao final da resposta, inclua as fontes neste formato exato:
   <div class="rag-fontes"><strong>Fontes consultadas:</strong> <cite>Nome do documento</cite></div>
6. NÃO invente informações que não estejam nos trechos fornecidos
7. Comece a resposta diretamente com a primeira tag HTML, sem texto introdutório

TRECHOS DOS DOCUMENTOS:
${contexto}

PERGUNTA DO USUÁRIO:
${pergunta}

Resposta em HTML:`;
}

// ── Geração ───────────────────────────────────────────────────────────────────

/**
 * Gera uma resposta em HTML usando o Gemini com base nos chunks recuperados do RAG.
 *
 * @param {string} pergunta Pergunta do usuário.
 * @param {Array}  chunks   Lista de chunks { nome, uri, texto, score } do Vertex AI Search.
 * @returns {Promise<string>} Fragmento HTML da resposta.
 */
export async function gerarRespostaGemini(pergunta, chunks) {
  const pid = projectId();

  const ai = new GoogleGenAI({
    vertexai: true,
    project:  pid,
    location: VERTEX_LOCATION,
    googleAuthOptions: { keyFilename: credentialsPath() },
  });

  const prompt = buildPrompt(pergunta, chunks);

  try {
    const response = await ai.models.generateContent({
      model: GEMINI_MODEL,
      contents: prompt,
      config: {
        temperature:     0.2,
        maxOutputTokens: 2048,
      },
    });

    const text = response.text ?? '';

    // Remove blocos markdown residuais que o modelo pode gerar ocasionalmente
    const html = text
      .replace(/^```html\s*/i, '')
      .replace(/^```\s*/,      '')
      .replace(/\s*```$/,      '')
      .trim();

    logger.info(`Gemini gerou resposta: ${html.length} chars | modelo=${GEMINI_MODEL}`);

    return html || '<p>Não foi possível gerar uma resposta. Tente reformular a pergunta.</p>';

  } catch (err) {
    logger.error(`Erro no Gemini: ${err.message}`);
    throw err;
  }
}