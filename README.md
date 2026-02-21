# Mandala Network Node

Server software that powers the Mandala Network — a decentralized mesh of independently operated nodes for hosting AI agent instances. Node operators earn BSV satoshis from deployers who use their compute.

## How the Network Works

The Mandala Network has no central coordinator. Each node is sovereign.

1. **Node operators** run `docker compose up` on any server with a public IP and domain to join the network
2. **Deployers** package their agent with an `agent-manifest.json`, point it at any node, and deploy
3. The node **provisions Kubernetes infrastructure** automatically — namespace, pods, ingress, SSL
4. **Billing** is per-use in BSV satoshis, metered every 5 minutes via Prometheus
5. Instances **auto-scale** horizontally based on CPU load (1-10 replicas)

Deployers choose which nodes to use and can deploy the same instance across multiple nodes for redundancy.

## Key Features

- **Decentralized** — No central authority. Anyone can run a node. Anyone can deploy.
- **BSV Micropayment Billing** — Real-time resource metering. Pay only for what you use, in satoshis.
- **Kubernetes Provisioning** — Each instance gets its own namespace, deployment, service, and ingress.
- **Automatic SSL** — Let's Encrypt certificates via cert-manager. Custom domain support with DNS verification.
- **Flexible Builds** — Pre-built Docker images, custom Dockerfiles, or auto-generated Dockerfiles for Node.js/Python.
- **Optional Infrastructure** — Per-instance MySQL, MongoDB, Redis, and persistent storage declared in the manifest.
- **GPU Support** — Resource limits including GPU allocation for AI workloads.
- **Health Checks** — Configurable liveness and readiness probes.
- **BSV Identity Auth** — All project management secured by BSV cryptographic identity (BRC-103/104).

## Architecture

```
Deployer (CLI / AuthFetch)
    ↓  BRC-103 signed requests
Mandala Node (Express.js, port 7777)
    ↓
MySQL 8.0 (projects, deployments, billing, logs)
    ↓
Kubernetes (K3s)
    ├── Agent Pod(s) — auto-scaled via HPA
    ├── Ingress — nginx + Let's Encrypt SSL
    ├── Databases — MySQL / MongoDB / Redis (optional)
    └── PVC — persistent storage (optional)
    ↓
Prometheus — resource metering → billing cron (every 5 min)
```

### Services (docker-compose)

| Container | Purpose | Port |
|-----------|---------|------|
| `mandala-node` | Main server | 7777 |
| `mandala-mysql` | MySQL database | 3306 |
| `mandala-k3s` | K3s Kubernetes cluster | 6443 |
| `mandala-registry` | Local Docker registry | 5000 |
| `mandala-dind` | Docker-in-Docker for image builds | 2375 |

## Prerequisites

- Docker and Docker Compose
- Public IP and domain name (with wildcard DNS for project subdomains)
- BSV mainnet private key (funded with 250k+ satoshis)
- BSV testnet private key
- TAAL API keys for mainnet and testnet ([taal.com](https://taal.com))
- SendGrid API key (optional, for email notifications)

## Quick Start

```bash
git clone <repo-url> && cd mandala-node

# Interactive setup wizard
npm install && npm run setup

# Or manually configure
cp .env.example .env
# Edit .env with your keys and domain

# Build and start all services
docker compose build
docker compose up -d
```

Verify:

```bash
curl http://localhost:7777/api/v1/public
```

See [GETTING_STARTED.md](./GETTING_STARTED.md) for full production deployment instructions.

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `MANDALA_NODE_PORT` | `7777` | Server port |
| `MANDALA_NODE_SERVER_BASEURL` | `http://localhost:7777` | Public URL of this node |
| `MAINNET_PRIVATE_KEY` | *required* | BSV mainnet private key (64-char hex) |
| `TESTNET_PRIVATE_KEY` | *required* | BSV testnet private key (64-char hex) |
| `TAAL_API_KEY_MAIN` | *required* | TAAL API key for mainnet |
| `TAAL_API_KEY_TEST` | *required* | TAAL API key for testnet |
| `MYSQL_DATABASE` | `mandala_db` | Database name |
| `MYSQL_USER` | `mandala_user` | Database username |
| `MYSQL_PASSWORD` | `mandala_pass` | Database password |
| `K3S_TOKEN` | `mandala-token` | K3s cluster token |
| `DOCKER_REGISTRY` | `mandala-registry:5000` | Docker registry host |
| `PROJECT_DEPLOYMENT_DNS_NAME` | `localhost` | Base domain for project subdomains |
| `PROMETHEUS_URL` | `http://prometheus.localhost:8081` | Prometheus endpoint |
| `SENDGRID_API_KEY` | — | SendGrid API key (optional) |
| `SYSTEM_FROM_EMAIL` | *required* | System notification sender email |
| `CERT_ISSUANCE_EMAIL` | *required* | Email for Let's Encrypt certificates |
| `CPU_RATE_PER_CORE_5MIN` | `1000` | Billing rate: satoshis per CPU core per 5 min |
| `MEM_RATE_PER_GB_5MIN` | `500` | Billing rate: satoshis per GB memory per 5 min |
| `DISK_RATE_PER_GB_5MIN` | `10` | Billing rate: satoshis per GB disk per 5 min |
| `NET_RATE_PER_GB_5MIN` | `200` | Billing rate: satoshis per GB network per 5 min |
| `LOG_LEVEL` | `info` | Logging level |
| `INIT_K3S` | — | Initialize K3s cluster on startup |

## Agent Manifest

Every deployment requires an `agent-manifest.json`. See [agent-manifest.example.json](./agent-manifest.example.json).

```json
{
  "schema": "mandala-agent",
  "schemaVersion": "1.0",
  "agent": {
    "type": "agidentity",
    "runtime": "node"
  },
  "env": {
    "AGID_MODEL": "claude-sonnet-4-5-20250929"
  },
  "resources": {
    "cpu": "500m",
    "memory": "512Mi"
  },
  "ports": [3000],
  "healthCheck": {
    "path": "/health",
    "port": 3000,
    "intervalSeconds": 30
  },
  "storage": {
    "enabled": true,
    "size": "10Gi",
    "mountPath": "/data"
  },
  "databases": {
    "mysql": false,
    "mongo": false,
    "redis": true
  },
  "deployments": [
    {
      "provider": "mandala",
      "projectID": "your-project-id",
      "network": "mainnet"
    }
  ]
}
```

### Agent Types

| Type | Description |
|------|-------------|
| `agidentity` | AGIdentity autonomous wallet agent |
| `openclaw` | General-purpose AI agent |
| `custom` | Your own implementation |

### Build Options

| Method | Manifest Field | Use Case |
|--------|---------------|----------|
| Pre-built image | `agent.image` | You already have a Docker image |
| Custom Dockerfile | `agent.dockerfile` | Specific build requirements |
| Auto-generated | `agent.runtime` (`node` / `python`) | Standard apps with typical layouts |

### Optional Infrastructure

| Resource | Manifest Field | What You Get |
|----------|---------------|--------------|
| MySQL 8.0 | `databases.mysql: true` | StatefulSet with PVC |
| MongoDB | `databases.mongo: true` | StatefulSet with PVC |
| Redis | `databases.redis: true` | Deployment |
| Persistent storage | `storage.enabled: true` | PVC mounted at `storage.mountPath` |

## Projects and Billing

Each instance lives inside a **project** with:

- A unique ID and BSV-denominated balance
- One or more admin users (identified by BSV identity keys)
- Optional blockchain funding for agents that transact on-chain

**Billing cycle:** Every 5 minutes, the node queries Prometheus for each project's resource usage, calculates cost at the configured rates, and debits the balance. Email alerts fire at configurable thresholds. Negative balance triggers ingress suspension.

**Top up:** Send satoshis to the project via `POST /api/v1/project/:id/pay`.

## API Reference

### Public

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/v1/public` | Node info, pricing, supported agent types, public keys |

### Authenticated (BRC-103/104)

**User Management**

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/v1/register` | Register new user |

**Projects**

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/v1/project/create` | Create a project |
| POST | `/api/v1/project/list` | List your projects |
| POST | `/api/v1/project/:id/info` | Project status and billing info |
| POST | `/api/v1/project/:id/pay` | Add funds (satoshis) |
| POST | `/api/v1/project/:id/delete` | Delete project and all resources |

**Deployments**

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/v1/project/:id/deploy` | Create deployment (returns signed upload URL) |
| POST | `/api/v1/upload/:deployId/:sig` | Upload artifact tarball |
| POST | `/api/v1/project/:id/deploys/list` | List deployments |

**Configuration**

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/v1/project/:id/agent/config` | Update agent config |
| POST | `/api/v1/project/:id/settings/update` | Update settings and env vars |
| POST | `/api/v1/project/:id/domains/frontend` | Set custom frontend domain |
| POST | `/api/v1/project/:id/domains/agent` | Set custom agent domain |

**Administration**

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/v1/project/:id/addAdmin` | Add admin to project |
| POST | `/api/v1/project/:id/removeAdmin` | Remove admin from project |
| POST | `/api/v1/project/:id/admins/list` | List project admins |
| POST | `/api/v1/project/:id/admin/restart` | Restart agent |
| POST | `/api/v1/project/:id/admin/status` | Pod status |

**Logs and Billing**

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/v1/project/:id/logs/project` | Project-level logs |
| POST | `/api/v1/project/:id/logs/deployment/:deployId` | Deployment logs |
| POST | `/api/v1/project/:id/logs/resource/:resource` | Resource logs (frontend, agent, mysql, mongo, redis) |
| POST | `/api/v1/project/:id/billing/stats` | Billing statistics |

## Production Deployment

1. Provision a Linux VPS (4GB+ RAM, 2+ vCPU, 50GB+ disk)
2. Install Docker, Nginx, Certbot
3. Configure DNS: `A` record for node domain + wildcard `*.projects.yourdomain.com`
4. Set up SSL with Let's Encrypt for the node itself
5. Configure Nginx as reverse proxy to port 7777
6. Deploy with systemd service or `docker compose up -d`

See [GETTING_STARTED.md](./GETTING_STARTED.md) for step-by-step instructions.

## Development

```bash
npm install
npm run start:dev    # Watch mode with tsx
npm run start:prod   # Production start
npm run setup        # Interactive .env setup wizard
```

### Project Structure

```
src/
├── server.ts          # Express server, middleware, startup
├── db.ts              # Knex MySQL connection
├── logger.ts          # Pino logger
├── cron.ts            # Scheduled jobs (billing, SSL, funding)
├── utils.ts           # Manifest schema, Dockerfile generators
├── init-cluster.ts    # K8s cluster initialization
├── routes/
│   ├── auth.ts        # User registration
│   ├── projects.ts    # Project CRUD, deployments, logs
│   ├── public.ts      # Public node info
│   └── upload.ts      # Artifact upload and provisioning
├── utils/
│   ├── wallet.ts      # BSV wallet operations
│   ├── billing.ts     # Prometheus queries, cost calculation
│   ├── email.ts       # SendGrid notifications
│   ├── SSLManager.ts  # cert-manager integration
│   └── ingress.ts     # Ingress management
└── migrations/        # Database schema migrations
```

## Security

- **BSV Identity Auth** — All project management endpoints use BRC-103/104 mutual authentication
- **Namespace Isolation** — Each project runs in its own Kubernetes namespace
- **Automatic HTTPS** — Let's Encrypt certificates for all instances
- **Private Keys** — Never exposed via API; stored only on the node
- **Signed Uploads** — Deployment artifacts uploaded via time-limited signed URLs

## License

Licensed under the open BSV license. See [LICENSE.txt](./LICENSE.txt).
