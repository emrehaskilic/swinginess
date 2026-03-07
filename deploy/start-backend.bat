@echo off
REM ============================================================
REM Start Backend Server in Production Mode
REM ============================================================

echo Starting Orderflow Backend Server...
echo.

cd /d "%~dp0.."

REM Set production environment
set NODE_ENV=production
set PORT=8787
set HOST=127.0.0.1

REM Optional: Set allowed origins (comma-separated)
REM set ALLOWED_ORIGINS=http://yourdomain.com,https://yourdomain.com

echo Environment:
echo   NODE_ENV=%NODE_ENV%
echo   PORT=%PORT%
echo   HOST=%HOST%
echo.

REM Start the server
node --experimental-specifier-resolution=node server/dist/index.js

pause
