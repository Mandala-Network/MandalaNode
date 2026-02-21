# Running a Mandala Network Node

This guide walks through setting up your own Mandala Network Node - joining the distributed network of servers that run AGiD instances. By the end, you'll have a fully operational node accepting AGiD deployments and earning BSV satoshis for compute.

## Overview

1. **Provision a Linux VPS** with a public IP
2. **Install dependencies**: Nginx, Docker, Certbot
3. **Configure DNS**: Domain + wildcard subdomain
4. **Configure credentials**: BSV keys, TAAL, SendGrid
5. **Start the node**
6. **Test with a sample AGiD deployment**

---

## 1. Provision a Server

**Any cloud provider works:** DigitalOcean, AWS, GCP, Hetzner, bare metal, etc.

**Minimum specs:**
- Debian 12 x64 (or Ubuntu 22.04+)
- 4GB RAM, 2 vCPU
- Public IPv4 address
- 50GB+ disk

**DNS setup** (replace `example.com` with your domain):
- `mandala.example.com` → your server IP
- `*.projects.example.com` → your server IP

```bash
ssh root@<your-ip>
apt update && apt upgrade -y
```

---

## 2. Install Dependencies

### Nginx + Certbot

```bash
apt install -y nginx-full certbot python3-certbot-nginx
```

### Firewall

```bash
ufw allow OpenSSH
ufw allow 80
ufw allow 443
ufw enable
```

### SSL for your node domain

```bash
certbot --nginx -d mandala.example.com
```

### Nginx routing

You need Nginx to:
- Terminate TLS for `mandala.example.com` → proxy to node (port 7777)
- Pass through TLS for `*.projects.example.com` → K8s ingress (port 6443)
- Proxy HTTP for `*.projects.example.com` → K8s ingress (port 6080) for ACME challenges

Add to `/etc/nginx/nginx.conf` (above the `http {}` block):

```nginx
stream {
    map $ssl_preread_server_name $upstream {
        mandala.example.com    127.0.0.1:4443;
        default                127.0.0.1:6443;
    }
    server {
        listen 443;
        ssl_preread on;
        proxy_pass $upstream;
    }
}
```

Create `/etc/nginx/sites-available/mandala.conf`:

```nginx
server {
    listen 80;
    server_name mandala.example.com;
    return 301 https://$host$request_uri;
}

server {
    listen 80;
    server_name projects.example.com *.projects.example.com;
    client_max_body_size 0;
    location / {
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $remote_addr;
        proxy_pass http://127.0.0.1:6080;
    }
}
```

Create `/etc/nginx/conf.d/mandala-ssl.conf`:

```nginx
server {
    listen 4443 ssl;
    server_name mandala.example.com;
    ssl_certificate /etc/letsencrypt/live/mandala.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/mandala.example.com/privkey.pem;
    include /etc/letsencrypt/options-ssl-nginx.conf;
    ssl_dhparam /etc/letsencrypt/ssl-dhparams.pem;
    client_max_body_size 0;
    location / {
        proxy_pass http://127.0.0.1:7777;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_cache_bypass $http_upgrade;
    }
}
```

```bash
ln -s /etc/nginx/sites-available/mandala.conf /etc/nginx/sites-enabled/
rm /etc/nginx/sites-enabled/default
nginx -t && systemctl reload nginx
```

### Docker

```bash
apt install -y ca-certificates curl gnupg
mkdir -p /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/debian/gpg | gpg --dearmor -o /etc/apt/keyrings/docker.gpg
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/debian $(lsb_release -cs) stable" | tee /etc/apt/sources.list.d/docker.list > /dev/null
apt update
apt install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
```

---

## 3. Install & Configure the Node

```bash
apt install -y git nodejs npm
git clone <repo-url> /opt/mandala-node
cd /opt/mandala-node
npm install
docker compose build
```

> **Important:** Build images _before_ creating `.env`, since `DOCKER_HOST=tcp://dind:2375` interferes with local Docker builds.

### Create `.env`

```bash
cp .env.example .env
```

Edit with your values:

| Variable | Value |
|---|---|
| `MANDALA_NODE_PORT` | `7777` |
| `MANDALA_NODE_SERVER_BASEURL` | `https://mandala.example.com` |
| `MYSQL_DATABASE` | `mandala_db` |
| `MYSQL_USER` | `mandala_user` |
| `MYSQL_PASSWORD` | *(generate strong password)* |
| `MYSQL_ROOT_PASSWORD` | *(generate strong password)* |
| `MAINNET_PRIVATE_KEY` | *(64-char hex, fund with 250k+ sats via [KeyFunder](https://keyfunder.babbage.systems))* |
| `TESTNET_PRIVATE_KEY` | *(64-char hex)* |
| `TAAL_API_KEY_MAIN` | *(from [taal.com](https://taal.com))* |
| `TAAL_API_KEY_TEST` | *(from taal.com)* |
| `K3S_TOKEN` | *(random string)* |
| `DOCKER_HOST` | `tcp://dind:2375` |
| `DOCKER_REGISTRY` | `mandala-registry:5000` |
| `PROJECT_DEPLOYMENT_DNS_NAME` | `projects.example.com` |
| `PROMETHEUS_URL` | `https://prometheus.projects.example.com` |
| `SENDGRID_API_KEY` | *(from [sendgrid.com](https://sendgrid.com))* |
| `SYSTEM_FROM_EMAIL` | `noreply@example.com` |
| `CERT_ISSUANCE_EMAIL` | `admin@example.com` |

---

## 4. Start the Node

```bash
docker compose up -d
docker compose logs -f mandala-node
```

Wait for it to stabilize, then verify:

```bash
curl https://mandala.example.com/api/v1/public
```

You should see your node's public keys, pricing rates, and supported agent types.

### Auto-start on boot

Create `/etc/systemd/system/mandala-node.service`:

```ini
[Unit]
Description=Mandala Network Node
After=network.target docker.service
Requires=docker.service

[Service]
Type=oneshot
WorkingDirectory=/opt/mandala-node
ExecStart=/usr/bin/docker compose up -d
ExecStop=/usr/bin/docker compose down
RemainAfterExit=yes

[Install]
WantedBy=multi-user.target
```

```bash
systemctl enable mandala-node
systemctl start mandala-node
```

---

## 5. Test with a Sample AGiD Deployment

### Create an `agent-manifest.json`

```json
{
  "schema": "mandala-agent",
  "schemaVersion": "1.0",
  "agent": {
    "type": "custom",
    "runtime": "node"
  },
  "ports": [8080],
  "healthCheck": { "path": "/health" },
  "deployments": [
    { "provider": "mandala", "projectID": "<your-project-id>", "network": "mainnet" }
  ]
}
```

### Deploy

1. Create a project via the API (authenticated with BSV identity)
2. Top up the project balance
3. Create a deployment to get an upload URL
4. Package your AGiD code + `agent-manifest.json` into a tarball
5. Upload to the signed URL

On success, your AGiD instance will be live at:
- `agent.<project-id>.projects.example.com`
- `frontend.<project-id>.projects.example.com` (if frontend configured)

---

## 6. Debugging

```bash
# Node logs
docker compose logs -f mandala-node

# K8s pods across all namespaces
docker exec -it mandala-k3s kubectl get pods -A

# Ingresses
docker exec -it mandala-k3s kubectl get ingresses -A

# Logs for a specific AGiD instance
docker exec -it mandala-k3s kubectl logs -n mandala-project-<id> <pod-name>
```

---

## 7. Upgrading

```bash
cd /opt/mandala-node
git pull
npm install
mv .env .env.bak && docker compose build && mv .env.bak .env
docker compose up -d
```

---

## 8. Tuning

- **Pricing:** Set `CPU_RATE_PER_CORE_5MIN`, `MEM_RATE_PER_GB_5MIN`, `DISK_RATE_PER_GB_5MIN`, `NET_RATE_PER_GB_5MIN` in `.env`
- **Monitoring:** Prometheus dashboard at `prometheus.projects.example.com`
- **Scaling:** For higher capacity, point `KUBECONFIG_FILE_PATH` to an external Kubernetes cluster and use an external MySQL instance and Docker registry

---

## You're now a Mandala Network Node operator

Your node is part of the distributed network. AGiD deployers can discover your node, deploy instances, and pay you in BSV satoshis for compute. The more AGiD instances running on your node, the more you earn.
