# VPS Deployment Guide — Lobre

Step-by-step commands untuk deploy Lobre ke VPS Linux (Ubuntu 22.04 LTS).

---

## Prerequisites

- VPS dengan Ubuntu 22.04 LTS (min. 1 vCPU, 2 GB RAM)
- Domain `lobre.lat` dengan DNS A record sudah mengarah ke IP VPS
- GitHub repo: `github.com/0xmrxp/kawz`
- Akun/keys yang sudah disiapkan: Groq API, EVM wallet, CDP API (untuk prod)

---

## Step 1 — Install Tools di VPS

```bash
# SSH ke VPS
ssh root@<VPS_IP>

# Install Bun
curl -fsSL https://bun.sh/install | bash
source ~/.bashrc
bun --version   # verify

# Install Docker + Docker Compose
apt-get update && apt-get install -y docker.io docker-compose-plugin
systemctl enable --now docker
docker --version   # verify

# Install Caddy
apt-get install -y debian-keyring debian-archive-keyring apt-transport-https curl
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
  | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
  | tee /etc/apt/sources.list.d/caddy-stable.list
apt-get update && apt-get install caddy
caddy version   # verify

# Install PM2
bun install -g pm2
pm2 --version   # verify
```

---

## Step 2 — Clone Repository

```bash
git clone https://github.com/0xmrxp/kawz.git /opt/lobre
cd /opt/lobre
```

---

## Step 3 — Install Dependencies

```bash
cd /opt/lobre
bun install --frozen-lockfile
```

---

## Step 4 — Setup Environment Variables

```bash
cp .env.example .env
nano .env
```

Isi semua nilai di `.env`:

```text
ENVIRONMENT=production
BASE_URL=https://lobre.lat
PORT=3000

REDIS_URL=redis://localhost:6379
GROQ_API_KEY=gsk_...            # dari console.groq.com
QDRANT_URL=http://localhost:6333

# x402 / CDP (untuk testnet, bisa dikosongkan dulu)
CDP_API_KEY_ID=
CDP_API_KEY_SECRET=

# MPP / Tempo
EVM_PAYEE_ADDRESS=0x...          # wallet address kamu
MPP_OPERATOR_KEY=
MPP_SECRET_KEY=                  # generate: openssl rand -hex 32
MPP_TEMPO_USDC_ADDRESS=0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913

# On-chain data (public defaults sudah benar)
BLOCKSCOUT_BASE_URL=https://base.blockscout.com
BASE_RPC_URL=https://mainnet.base.org

# Opsional
GOOGLE_FACTCHECK_API_KEY=
```

Generate `MPP_SECRET_KEY`:
```bash
openssl rand -hex 32
```

---

## Step 5 — Start Redis + Qdrant (Docker)

```bash
mkdir -p /var/log/lobre
cd /opt/lobre
docker compose -f infra/docker-compose.yml up -d

# Verify containers running
docker compose -f infra/docker-compose.yml ps
```

---

## Step 6 — Build Astro Frontend

```bash
cd /opt/lobre/src/frontend
bun install
bun run build
# Output: /opt/lobre/src/frontend/dist/
```

---

## Step 7 — Setup Caddy (Reverse Proxy + Auto HTTPS)

> **Catatan DNS Cloudflare:** Pastikan A record `lobre.lat` di Cloudflare di-set ke **gray cloud (DNS Only)**, bukan orange cloud. Caddy butuh akses langsung ke port 80/443 untuk Let's Encrypt HTTP-01 challenge.

```bash
# Copy Caddyfile ke lokasi resmi
cp /opt/lobre/infra/Caddyfile /etc/caddy/Caddyfile

# Reload Caddy (auto-request TLS dari Let's Encrypt)
systemctl reload caddy

# Verify TLS aktif
curl -I https://lobre.lat/api/health
# Expect: HTTP/2 200
```

---

## Step 8 — Start Lobre via PM2

```bash
cd /opt/lobre

# Start
pm2 start infra/ecosystem.config.cjs

# Persist across reboots
pm2 save
pm2 startup
# Jalankan perintah yang muncul dari pm2 startup

# Verify server running
pm2 status
curl https://lobre.lat/api/health
# Expect: { "status": "ok", "version": "1.0.0", "env": "production" }
```

---

## Step 9 — Setup GitHub Actions Auto-Deploy

Di GitHub repo → **Settings → Secrets → Actions**, tambahkan:

| Secret | Nilai |
|---|---|
| `VPS_HOST` | IP address VPS kamu |
| `VPS_USER` | `root` (atau username SSH) |
| `VPS_SSH_KEY` | Private key SSH (isi lengkap termasuk header `-----BEGIN`) |

Setelah ini, setiap `git push` ke branch `main` akan otomatis:
1. SSH ke VPS
2. `git pull origin main`
3. `bun install --frozen-lockfile`
4. `pm2 reload lobre --update-env`

---

## Step 10 — Test Payment Flow (Testnet)

```bash
# Test tanpa payment (expect 402)
curl -I https://lobre.lat/api/v1/trading/engine/vitals

# Install agentcash CLI
npm install -g agentcash

# Onboard wallet (Base Sepolia test network)
npx agentcash onboard

# Try endpoint — agent akan auto-pay via testnet
npx agentcash fetch https://lobre.lat/api/v1/trading/engine/vitals
```

Untuk test USDC Base Sepolia: faucet di `faucet.circle.com`

---

## Step 11 — Production Migration (Fase 9)

Ganti testnet facilitator ke CDP production:

```bash
nano /opt/lobre/.env
```

Update:
```text
CDP_API_KEY_ID=your_cdp_key_id        # dari portal.cdp.coinbase.com
CDP_API_KEY_SECRET=your_cdp_key_secret
```

Reload:
```bash
pm2 reload lobre --update-env
```

---

## Step 12 — Registrasi Discovery (Fase 10)

Setelah server live dan endpoint accessible:

```bash
# Validate discovery
npx -y @agentcash/discovery@latest discover "https://lobre.lat"
npx -y @agentcash/discovery@latest check "https://lobre.lat"

# Daftarkan di:
# https://www.x402scan.com/resources/register
# https://www.mppscan.com/register
```

---

## Useful PM2 Commands

```bash
pm2 status              # lihat status semua proses
pm2 logs lobre          # lihat live logs
pm2 logs lobre --err    # lihat error logs saja
pm2 reload lobre        # reload tanpa downtime
pm2 restart lobre       # hard restart
pm2 stop lobre          # stop
pm2 monit               # dashboard monitoring real-time
```

## Useful Docker Commands

```bash
# Cek containers
docker compose -f /opt/lobre/infra/docker-compose.yml ps

# Restart Redis
docker compose -f /opt/lobre/infra/docker-compose.yml restart redis

# Lihat Redis logs
docker compose -f /opt/lobre/infra/docker-compose.yml logs redis

# Connect ke Redis CLI
docker exec -it lobre_redis redis-cli
```

## Useful Caddy Commands

```bash
caddy validate --config /etc/caddy/Caddyfile   # validasi config
systemctl reload caddy                           # reload setelah edit Caddyfile
systemctl status caddy                           # cek status
journalctl -u caddy -f                          # lihat logs real-time
```

---

## Troubleshooting

**Server tidak mau start:**
```bash
pm2 logs lobre --err --lines 50
# Lihat error — biasanya missing env var atau port already in use
```

**TLS/HTTPS tidak aktif:**
```bash
# Pastikan port 80 dan 443 terbuka di firewall
ufw allow 80
ufw allow 443
# Pastikan Cloudflare DNS set ke gray cloud (DNS only), bukan orange cloud
```

**Redis connection refused:**
```bash
docker compose -f /opt/lobre/infra/docker-compose.yml ps
# Kalau redis container tidak running:
docker compose -f /opt/lobre/infra/docker-compose.yml up -d redis
```

**Qdrant tidak bisa diakses:**
```bash
curl http://localhost:6333/health
# Kalau gagal, restart container:
docker compose -f /opt/lobre/infra/docker-compose.yml restart qdrant
```
