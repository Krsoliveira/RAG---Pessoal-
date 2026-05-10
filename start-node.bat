@echo off
REM ============================================================
REM  start-node.bat — Servidor RAG Node.js (meu-rag-java-2026)
REM ============================================================
REM  Pré-requisitos:
REM    - Node.js 20+ (node --version)
REM    - credentials_rag.json na raiz do repositório
REM    - Arquivo .env preenchido
REM ============================================================
REM  Uso:
REM    start-node.bat          (porta padrão: 3000)
REM    start-node.bat 8080     (porta customizada)
REM ============================================================

setlocal EnableDelayedExpansion

REM ── Porta (argumento opcional) ────────────────────────────────────────────
if not "%~1"=="" (
    set PORT=%~1
) else (
    set PORT=3000
)

REM ── Carrega variáveis do .env ─────────────────────────────────────────────
set ENV_FILE=%~dp0.env
if not exist "%ENV_FILE%" (
    echo [ERRO] Arquivo .env nao encontrado em %ENV_FILE%
    echo        Preencha o .env com suas credenciais e tente novamente.
    exit /b 1
)

for /f "usebackq tokens=1,* delims==" %%A in ("%ENV_FILE%") do (
    set "LINE=%%A"
    if not "!LINE:~0,1!"=="#" if not "!LINE!"=="" (
        set "%%A=%%B"
    )
)

REM ── Valida credenciais ────────────────────────────────────────────────────
if "%GCP_VERTEX_CREDENTIALS_PATH%"=="" (
    echo [ERRO] GCP_VERTEX_CREDENTIALS_PATH nao configurado no .env
    exit /b 1
)

REM ── Instala dependências se necessário ───────────────────────────────────
cd /d "%~dp0javascript"

if not exist "node_modules" (
    echo [INFO] Instalando dependencias Node.js...
    call npm install
    if errorlevel 1 (
        echo [ERRO] Falha ao instalar dependencias.
        exit /b 1
    )
)

REM ── Informa configuração ──────────────────────────────────────────────────
echo.
echo  Projeto  : meu-rag-java-2026
echo  Bucket   : %GCP_STORAGE_BUCKET%
echo  DataStore: %GCP_VERTEX_DATA_STORE_ID%
echo  Porta    : %PORT%
echo.
echo  Acesse: http://localhost:%PORT%
echo  Pressione Ctrl+C para parar o servidor.
echo.

REM ── Inicia o servidor ─────────────────────────────────────────────────────
node server.js

endlocal