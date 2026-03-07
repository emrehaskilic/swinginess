# Orderflow Telemetry Dashboard - Deployment Guide

## Quick Start (Windows VPS)

### Prerequisites
1. Node.js 18+ installed
2. Nginx for Windows (download from https://nginx.org/en/download.html)
3. Extract Nginx to `C:\nginx`

### Deployment Steps

#### 1. Build Frontend
```bash
cd "C:\Users\Administrator\Desktop\New folder"
npm run build
```

#### 2. Install Nginx
- Download: https://nginx.org/en/download.html (Windows version)
- Extract to `C:\nginx`
- Copy `deploy\nginx.conf` to `C:\nginx\conf\nginx.conf`

#### 3. Copy Built Files
```bash
xcopy /E /Y dist\* C:\nginx\html\dist\
```

#### 4. Start Services

**Start Backend (run in separate terminal):**
```bash
cd "C:\Users\Administrator\Desktop\New folder"
set NODE_ENV=production
set PORT=8787
set HOST=127.0.0.1
npx ts-node server/index.ts
```

Or for production (compile first):
```bash
npx tsc -p server/tsconfig.json
node server/dist/index.js
```

**Start Nginx:**
```bash
cd C:\nginx
nginx
```

#### 5. Open Firewall Ports
```powershell
# Run as Administrator
netsh advfirewall firewall add rule name="HTTP" dir=in action=allow protocol=tcp localport=80
netsh advfirewall firewall add rule name="HTTPS" dir=in action=allow protocol=tcp localport=443
```

#### 6. Access Dashboard
- Local: http://localhost
- Network: http://YOUR_VPS_IP

---

## Production Architecture

```
                    ┌─────────────────────────────────────┐
                    │           VPS (Windows)             │
                    │                                     │
  Internet ─────────┼──► Nginx (Port 80/443)              │
                    │         │                           │
                    │         ├──► / (Static Frontend)    │
                    │         │                           │
                    │         ├──► /api/* ───────────────►├──► Backend (127.0.0.1:8787)
                    │         │                           │           │
                    │         └──► /ws ──────────────────►├───────────┘
                    │                                     │
                    │    Backend ──► Binance API          │
                    │                                     │
                    └─────────────────────────────────────┘
```

## Key Points

1. **Backend listens on localhost only (127.0.0.1:8787)**
   - Not exposed to internet directly
   - All traffic goes through Nginx

2. **Frontend built as static files**
   - Served by Nginx from `/html/dist/`
   - No Node.js required for frontend

3. **WebSocket proxied correctly**
   - Upgrade headers configured
   - Long timeouts (7 days) for persistent connections

4. **No Binance requests from browser**
   - All Binance API calls made by backend
   - Frontend only talks to your server

---

## HTTPS Setup (Let's Encrypt)

### For Windows with Certbot:
1. Install Certbot: https://certbot.eff.org/instructions?ws=nginx&os=windows
2. Run: `certbot --nginx -d yourdomain.com`
3. Auto-renewal: `certbot renew --dry-run`

### Manual Certificate:
1. Uncomment SSL lines in nginx.conf
2. Update certificate paths
3. Reload Nginx: `nginx -s reload`

---

## Troubleshooting

### WebSocket Connection Issues
- Check: `nginx -t` for config errors
- Verify backend is running on port 8787
- Check firewall rules

### CORS Errors
- Add your domain to `ALLOWED_ORIGINS` env var
- Example: `set ALLOWED_ORIGINS=http://yourdomain.com,https://yourdomain.com`

### 502 Bad Gateway
- Backend not running or wrong port
- Check: `netstat -ano | findstr 8787`

---

## Service Management

### Run Backend as Windows Service
Use `nssm` (Non-Sucking Service Manager):
```bash
nssm install OrderflowBackend "C:\Program Files\nodejs\node.exe" "C:\path\to\server\index.js"
nssm set OrderflowBackend AppDirectory "C:\Users\Administrator\Desktop\New folder"
nssm start OrderflowBackend
```

### Nginx as Service
```bash
nssm install Nginx "C:\nginx\nginx.exe"
nssm set Nginx AppDirectory "C:\nginx"
nssm start Nginx
```
