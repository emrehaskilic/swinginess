@echo off
REM ============================================================
REM Orderflow Telemetry Dashboard - Windows Deployment Script
REM ============================================================

echo.
echo ========================================
echo   Orderflow Dashboard Deployment
echo ========================================
echo.

REM Set variables
set PROJECT_DIR=%~dp0..
set NGINX_DIR=C:\nginx
set DIST_DIR=%PROJECT_DIR%\dist

REM Step 1: Build Frontend
echo [1/5] Building frontend...
cd /d "%PROJECT_DIR%"
call npm run build
if errorlevel 1 (
    echo ERROR: Frontend build failed!
    pause
    exit /b 1
)
echo Frontend build complete.
echo.

REM Step 2: Copy dist to Nginx
echo [2/5] Copying build to Nginx...
if not exist "%NGINX_DIR%\html\dist" mkdir "%NGINX_DIR%\html\dist"
xcopy /E /Y /Q "%DIST_DIR%\*" "%NGINX_DIR%\html\dist\"
echo Copy complete.
echo.

REM Step 3: Copy Nginx config
echo [3/5] Updating Nginx config...
copy /Y "%PROJECT_DIR%\deploy\nginx.conf" "%NGINX_DIR%\conf\nginx.conf"
echo Nginx config updated.
echo.

REM Step 4: Test Nginx config
echo [4/5] Testing Nginx configuration...
cd /d "%NGINX_DIR%"
nginx -t
if errorlevel 1 (
    echo ERROR: Nginx config test failed!
    pause
    exit /b 1
)
echo Nginx config OK.
echo.

REM Step 5: Reload Nginx
echo [5/5] Reloading Nginx...
nginx -s reload 2>nul || nginx
echo.

echo ========================================
echo   Deployment Complete!
echo ========================================
echo.
echo Access your dashboard at:
echo   - http://YOUR_VPS_IP
echo   - Or your configured domain
echo.
echo Backend should be running on port 8787
echo.
pause
