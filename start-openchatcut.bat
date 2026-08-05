@echo off
setlocal enabledelayedexpansion
title OpenChatCut launcher
cd /d "%~dp0"

set PORT=5199
set URL=http://localhost:%PORT%/
set MCP=http://localhost:%PORT%/api/external-mcp/mcp

echo ========================================================================
echo   OpenChatCut launcher
echo   Run this BEFORE opening Claude Desktop or Other AI Coding Platform.
echo ========================================================================
echo.

REM --- Already up? Then don't start a second one. ---
set CODE=000
for /f %%s in ('curl -s -o nul -w "%%{http_code}" --max-time 2 %URL% 2^>nul') do set CODE=%%s
if "!CODE!"=="200" (
    echo [ok] OpenChatCut is already running on port %PORT%.
    set STARTED=0
    goto ready
)

if not exist "node_modules" (
    echo [..] node_modules not found - running npm install first...
    call npm install
    if errorlevel 1 (
        echo [!!] npm install failed. Fix the error above and re-run this launcher.
        pause
        endlocal
        exit /b 1
    )
    echo [ok] Dependencies installed.
    echo.
)

echo [..] Starting dev server on port %PORT% ...
start "OpenChatCut server" /min cmd /c "npm run dev"
set STARTED=1

REM --- Poll the port until Vite answers, max ~90s ---
set /a TRIES=0
:wait
set /a TRIES+=1
if !TRIES! gtr 90 goto timeout
ping -n 2 127.0.0.1 >nul
set CODE=000
for /f %%s in ('curl -s -o nul -w "%%{http_code}" --max-time 2 %URL% 2^>nul') do set CODE=%%s
if not "!CODE!"=="200" goto wait
echo [ok] Dev server is up after !TRIES!s.

:ready
REM --- Confirm the MCP endpoint really speaks MCP, not just that the port is open ---
set MCODE=000
for /f %%s in ('curl -s -o nul -w "%%{http_code}" --max-time 5 -X POST %MCP% -H "Content-Type: application/json" -H "Accept: application/json, text/event-stream" -H "x-openchatcut-mcp-client: claude-code" -H "x-openchatcut-mcp-surface: external" -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"initialize\",\"params\":{\"protocolVersion\":\"2025-06-18\",\"capabilities\":{},\"clientInfo\":{\"name\":\"launcher\",\"version\":\"1\"}}}" 2^>nul') do set MCODE=%%s

echo.
if "!MCODE!"=="200" (
    echo   MCP endpoint: READY  ^(%MCP%^)
) else (
    echo   MCP endpoint: NOT READY - got HTTP !MCODE!
    echo   The editor may still be booting. Wait a few seconds and re-run.
)
echo.
echo ========================================================================
echo   OpenChatCut is running. Now connect your AI coding agent:
echo ========================================================================
echo.
echo   IF YOU USE CLAUDE CODE (terminal):
echo     Just run "claude" from this folder. This repo already has a
echo     .mcp.json, so the openchatcut_* tools attach automatically -
echo     nothing else to do.
echo.
echo   IF YOU USE CLAUDE DESKTOP or ANOTHER AGENT:
echo     Register the MCP server once, from a terminal (not the chat box):
echo       claude mcp add --transport http openchatcut %MCP%
echo     ^(Claude Desktop instead: Settings -^> Developer -^> Edit Config,
echo      add an "openchatcut" entry pointing at %MCP%, then restart it.^)
echo.
echo   THEN, in the chat, describe the actual edit you want, e.g.:
echo     "Start an OpenChatCut edit session and add a jump cut at 12s.
echo      Submit for review and wait for me to approve it in OpenChatCut."
echo ========================================================================
echo.
echo   Editor: %URL%
echo.
set /p OPENBROWSER="Edit Video on %URL% in your browser now? [Y/N]: "
if /i "!OPENBROWSER!"=="Y" (
    start "" "%URL%"
) else (
    echo   Skipping browser launch - use your own AI coding platform / browser tab.
)
echo.
if "!STARTED!"=="1" (
    echo   Leave this window OPEN while you work.
    echo   Press any key to STOP OpenChatCut and exit.
    pause >nul
    echo.
    echo [..] Stopping OpenChatCut ...
    for /f "tokens=5" %%p in ('netstat -ano ^| findstr ":%PORT%" ^| findstr "LISTENING"') do taskkill /PID %%p /T /F >nul 2>&1
    echo [ok] Stopped.
) else (
    echo   This launcher did not start the server, so it will
    echo   leave the existing one running.
    echo   Press any key to close this window.
    pause >nul
)
endlocal
exit /b 0

:timeout
echo.
echo [!!] Timed out after 90s waiting for port %PORT%.
echo      Check the "OpenChatCut server" window for errors.
pause
endlocal
exit /b 1
