import path from 'path';

/**
 * Agent manifest schema for Mandala Network Node deployments.
 * Replaces the old deployment-info.json schema.
 */
export interface AgentManifest {
  schema: 'mandala-agent'
  schemaVersion: '1.0'
  agent: {
    type: 'openclaw' | 'agidentity' | 'custom'
    image?: string           // pre-built Docker image (skip build)
    dockerfile?: string      // path to Dockerfile in artifact
    buildContext?: string    // build context dir (default '.')
    runtime?: 'node' | 'python' | 'docker'
  }
  env?: Record<string, string>
  resources?: { cpu?: string; memory?: string; gpu?: string }
  ports?: number[]           // default [8080]
  healthCheck?: { path: string; port?: number; intervalSeconds?: number }
  frontend?: { directory?: string; image?: string }
  storage?: { enabled: boolean; size?: string; mountPath?: string }
  databases?: { mysql?: boolean; mongo?: boolean; redis?: boolean }
  deployments?: Array<{ provider: 'mandala'; projectID?: string; network?: string }>
}

/**
 * generateAgentDockerfile:
 * Produces a Dockerfile for agent containers based on runtime type.
 */
export function generateAgentDockerfile(manifest: AgentManifest): string {
  const runtime = manifest.agent.runtime || 'node';
  const ports = manifest.ports || [8080];
  const exposeStatements = ports.map(p => `EXPOSE ${p}`).join('\n');

  if (runtime === 'node') {
    return `FROM docker.io/node:22-alpine
WORKDIR /app
COPY package*.json ./
RUN npm install --production
COPY . .
${exposeStatements}
CMD ["node", "index.js"]`;
  }

  if (runtime === 'python') {
    return `FROM docker.io/python:3.12-slim
WORKDIR /app
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt
COPY . .
${exposeStatements}
CMD ["python", "main.py"]`;
  }

  // runtime === 'docker' - generic fallback
  return `FROM docker.io/node:22-alpine
WORKDIR /app
COPY . .
${exposeStatements}
CMD ["node", "index.js"]`;
}

/**
 * generateFrontendDockerfile:
 * Produces a Dockerfile for serving static frontend files via nginx.
 */
export function generateFrontendDockerfile(): string {
  return `FROM docker.io/nginx:alpine
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY . /usr/share/nginx/html
EXPOSE 80`;
}

/**
 * generateAgidentityDockerfile:
 * Produces a Dockerfile for AGIdentity agent containers.
 */
export function generateAgidentityDockerfile(manifest: AgentManifest): string {
  const ports = manifest.ports || [3000];
  const exposeStatements = ports.map(p => `EXPOSE ${p}`).join('\n');
  return `FROM docker.io/node:22-slim
RUN apt-get update && apt-get install -y build-essential python3 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package*.json tsconfig.json ./
COPY mpc/ ./mpc/
RUN npm install --production=false
COPY src/ ./src/
COPY workspace/ ./workspace/ 2>/dev/null || true
RUN npm run build
ENV NODE_ENV=production
ENV AUTH_SERVER_PORT=3000
ENV AGID_WORKSPACE_PATH=/data/workspace
ENV AGID_SESSIONS_PATH=/data/sessions
${exposeStatements}
CMD ["node", "dist/start.js"]`;
}

/**
 * generateNginxConf:
 * Minimal nginx config for static file serving.
 */
export function generateNginxConf(): string {
  return `server {
    listen 80;
    server_name localhost;
    root /usr/share/nginx/html;
    location / {
        try_files $uri /404.html /index.html;
    }
}`;
}
