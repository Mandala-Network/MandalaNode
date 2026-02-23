import { Request, Response } from 'express';
import fs from 'fs-extra';
import path from 'path';
import { Utils, WalletInterface } from '@bsv/sdk';
import type { Knex } from 'knex';
import { execSync } from 'child_process';
import logger from '../logger';
import {
  AgentManifest,
  AgentManifestV2,
  isV2Manifest,
  generateAgentDockerfile,
  generateAgidentityDockerfile,
  generateFrontendDockerfile,
  generateNginxConf,
} from '../utils';
import { findBalanceForKey, fundKey } from '../utils/wallet';
import { sendDeploymentFailureEmail } from '../utils/email';
import { refreshAdvertisement } from '../utils/registry';

const projectsDomain: string = process.env.PROJECT_DEPLOYMENT_DNS_NAME!;

export default async (req: Request, res: Response) => {
  const { db, mainnetWallet: wallet, testnetWallet }: { db: Knex, mainnetWallet: WalletInterface, testnetWallet: WalletInterface } = req as any;
  const { deploymentId, signature } = req.params;

  // Helper function to log steps to DB logs and logger
  async function logStep(message: string, level: 'info' | 'error' = 'info') {
    const logObj = {
      project_id: deploy?.project_id,
      deploy_id: deploy?.id,
      message
    };
    await db('logs').insert(logObj);
    if (level === 'info') {
      logger.info({ deploymentId }, message);
    } else {
      logger.error({ deploymentId }, message);
    }
  }

  // Helper to run commands with error handling
  function runCmd(cmd: string, options: any = {}) {
    try {
      const output = execSync(cmd, { stdio: 'pipe', encoding: 'utf-8', ...options });
      if (output) logger.info({ cmd: cmd.substring(0, 80) }, output.substring(0, 2000));
    } catch (err: any) {
      const stderr = err.stderr ? String(err.stderr).substring(0, 3000) : '';
      const stdout = err.stdout ? String(err.stdout).substring(0, 3000) : '';
      logger.error({ cmd, stderr, stdout }, `Command failed: ${cmd}`);
      throw new Error(`Command failed (${cmd}): ${stderr || stdout || err.message}`);
    }
  }

  let deploy: any;
  let project: any;

  try {
    // 1) Validate deployment record
    deploy = await db('deploys').where({ deployment_uuid: deploymentId }).first();
    if (!deploy) {
      return res.status(400).json({ error: 'Invalid deploymentId' });
    }

    // 2) Fetch project
    project = await db('projects').where({ id: deploy.project_id }).first();
    if (!project) {
      return res.status(400).json({ error: 'Project not found' });
    }

    // 3) Verify signature
    const { valid } = await wallet.verifySignature({
      data: Utils.toArray(deploymentId, 'hex'),
      signature: Utils.toArray(signature, 'hex'),
      protocolID: [2, 'url signing'],
      keyID: deploymentId,
      counterparty: 'self'
    });

    if (!valid) {
      return res.status(401).json({ error: 'Invalid signature' });
    }

    // 4) Check project balance
    if (project.balance < 1) {
      return res.status(401).json({ error: `Project balance must be at least 1 satoshi to upload a deployment. Current balance: ${project.balance}` });
    }

    // 5) Store file locally
    const filePath = path.join('/tmp', `artifact_${deploymentId}.tgz`);
    fs.writeFileSync(filePath, req.body); // raw data from request
    await db('deploys').where({ id: deploy.id }).update({ file_path: filePath });
    await logStep(`File uploaded successfully, saved to ${filePath}`);

    // 6) Create a working directory for extraction
    const uploadDir = path.join('/tmp', `build_${deploymentId}`);
    fs.ensureDirSync(uploadDir);

    // 7) Extract tarball
    runCmd(`tar -xzf ${filePath} -C ${uploadDir}`);
    await logStep(`Tarball extracted at ${uploadDir}`);

    // 8) Validate agent-manifest.json
    const manifestPath = path.join(uploadDir, 'agent-manifest.json');
    if (!fs.existsSync(manifestPath)) {
      const errMsg = 'agent-manifest.json not found in tarball.';
      await logStep(errMsg, 'error');
      return res.status(400).json({ error: errMsg });
    }

    const rawManifest = JSON.parse(
      fs.readFileSync(manifestPath, 'utf-8')
    );
    if (rawManifest.schema !== 'mandala-agent') {
      const errMsg = 'Invalid schema in agent-manifest.json (expected "mandala-agent")';
      await logStep(errMsg, 'error');
      return res.status(400).json({ error: errMsg });
    }

    // 8b) Detect v2 manifest and extract service definition
    let manifest: AgentManifest;
    let serviceName: string | undefined;

    if (isV2Manifest(rawManifest)) {
      serviceName = req.query.serviceName as string || req.headers['x-mandala-service'] as string;
      if (!serviceName || !rawManifest.services[serviceName]) {
        const errMsg = 'v2 manifest requires serviceName param identifying which service to deploy';
        await logStep(errMsg, 'error');
        return res.status(400).json({ error: errMsg });
      }
      const svc = rawManifest.services[serviceName];
      manifest = {
        schema: 'mandala-agent',
        schemaVersion: '1.0',
        agent: svc.agent,
        env: { ...(rawManifest.env || {}), ...(svc.env || {}) },
        resources: svc.resources,
        ports: svc.ports,
        healthCheck: svc.healthCheck,
        frontend: svc.frontend || undefined,
        storage: svc.storage,
        databases: svc.databases,
        deployments: rawManifest.deployments?.map(d => ({
          provider: d.provider,
          projectID: d.projectID,
          network: d.network,
          MandalaCloudURL: d.MandalaCloudURL
        }))
      };
      await logStep(`v2 manifest detected, deploying service: ${serviceName}`);
    } else {
      manifest = rawManifest as AgentManifest;
    }

    // 8c) Reject GPU requests on non-GPU nodes
    if (manifest.resources?.gpu && process.env.GPU_ENABLED !== 'true') {
      return res.status(400).json({ error: 'This node does not support GPU workloads.' });
    }

    // 9) Check for matching Mandala deployment config
    const deployConfig = manifest.deployments?.find(
      (d) => d.provider === 'mandala' && d.projectID === project.project_uuid
    );

    if (!deployConfig || !deployConfig.projectID) {
      const errMsg = 'No matching Mandala deployment config or projectID in agent-manifest.json';
      await logStep(errMsg, 'error');
      return res.status(400).json({ error: errMsg });
    }

    if (deployConfig.network && deployConfig.network !== project.network) {
      const errMsg = `Network mismatch: Project is on ${project.network} but deployment config specifies ${deployConfig.network}`;
      await logStep(errMsg, 'error');
      return res.status(400).json({ error: errMsg });
    }

    // 9b) Store service_name on deploy record if v2
    if (serviceName) {
      await db('deploys').where({ id: deploy.id }).update({ service_name: serviceName });
    }

    // 10) Build/push Docker images
    const registryHost = process.env.DOCKER_REGISTRY || 'mandala-registry:5000';
    let agentImage: string | null = null;
    let frontendImage: string | null = null;

    // --- Agent (backend) build/push ---
    if (manifest.agent.image) {
      // Pre-built image provided - use it directly
      agentImage = manifest.agent.image;
      await logStep(`Using pre-built agent image: ${agentImage}`);
    } else {
      agentImage = `${registryHost}/mandala-project-${project.project_uuid}/agent:${deploymentId}`;
      await logStep('Building agent image...');

      const buildContext = manifest.agent.buildContext || '.';
      const buildDir = path.join(uploadDir, buildContext);

      if (!fs.existsSync(buildDir)) {
        const errMsg = `Build context directory "${buildContext}" not found in artifact.`;
        await logStep(errMsg, 'error');
        return res.status(400).json({ error: errMsg });
      }

      // Determine Dockerfile
      if (manifest.agent.type === 'agidentity') {
        // AGIdentity agent — use specialized Dockerfile
        fs.writeFileSync(
          path.join(buildDir, 'Dockerfile'),
          generateAgidentityDockerfile(manifest, buildDir)
        );
      } else if (manifest.agent.dockerfile) {
        // User-provided Dockerfile
        const userDockerfilePath = path.join(uploadDir, manifest.agent.dockerfile);
        if (!fs.existsSync(userDockerfilePath)) {
          const errMsg = `Specified Dockerfile "${manifest.agent.dockerfile}" not found.`;
          await logStep(errMsg, 'error');
          return res.status(400).json({ error: errMsg });
        }
        // Copy user Dockerfile into build context if not already there
        const targetDockerfile = path.join(buildDir, 'Dockerfile');
        if (userDockerfilePath !== targetDockerfile) {
          fs.copyFileSync(userDockerfilePath, targetDockerfile);
        }
      } else {
        // Generate Dockerfile from runtime
        fs.writeFileSync(
          path.join(buildDir, 'Dockerfile'),
          generateAgentDockerfile(manifest)
        );
      }

      // Build + push
      runCmd(`buildah build --storage-driver=vfs --isolation=chroot -t ${agentImage} ${buildDir}`);
      await logStep(`Agent image built: ${agentImage}`);
      runCmd(`buildah push --tls-verify=false --storage-driver=vfs ${agentImage}`);
      await logStep(`Agent image pushed: ${agentImage}`);
    }

    // --- Frontend build/push ---
    if (manifest.frontend) {
      if (manifest.frontend.image) {
        frontendImage = manifest.frontend.image;
        await logStep(`Using pre-built frontend image: ${frontendImage}`);
      } else {
        frontendImage = `${registryHost}/mandala-project-${project.project_uuid}/frontend:${deploymentId}`;
        await logStep('Building frontend image...');

        const frontendDir = path.join(uploadDir, manifest.frontend.directory || 'frontend');
        if (!fs.existsSync(frontendDir)) {
          const errMsg = 'Frontend directory not found but frontend config specified.';
          await logStep(errMsg, 'error');
          return res.status(400).json({ error: errMsg });
        }

        // Add nginx config and Dockerfile
        fs.writeFileSync(path.join(frontendDir, 'nginx.conf'), generateNginxConf());
        fs.writeFileSync(path.join(frontendDir, 'Dockerfile'), generateFrontendDockerfile());

        // Build + push
        runCmd(`buildah build --storage-driver=vfs --isolation=chroot -t ${frontendImage} .`, { cwd: frontendDir });
        await logStep(`Frontend image built: ${frontendImage}`);
        runCmd(`buildah push --storage-driver=vfs --tls-verify=false ${frontendImage}`, { cwd: frontendDir });
        await logStep(`Frontend image pushed: ${frontendImage}`);
      }
    }

    // 11) Prepare environment variables from manifest.env merged with project agent_config
    let agentConfigObj: Record<string, string> = {};
    try {
      agentConfigObj = project.agent_config ? JSON.parse(project.agent_config) : {};
    } catch {
      agentConfigObj = {};
    }

    // Merge: manifest.env is base, project agent_config overrides
    const mergedEnv: Record<string, string> = {
      ...(manifest.env || {}),
      ...agentConfigObj
    };

    // 12) Fund project key only if requires_blockchain_funding
    if (project.requires_blockchain_funding) {
      const projectServerPrivateKey = project.private_key;
      const keyBalance = await findBalanceForKey(projectServerPrivateKey, project.network);
      if (keyBalance < 100) {
        try {
          await fundKey(project.network === 'mainnet' ? wallet : testnetWallet, projectServerPrivateKey, 500, project.network);
        } catch (e) {
          logger.error({ err: e, network: project.network }, 'Server could not fund a project private key')
        }
      }
    }

    // 13) Generate Helm chart
    const helmDir = path.join(uploadDir, 'helm');
    fs.ensureDirSync(helmDir);

    // Chart.yaml
    fs.writeFileSync(
      path.join(helmDir, 'Chart.yaml'),
      `apiVersion: v2
name: mandala-project
version: 0.1.0
description: A chart to deploy a Mandala project
`
    );

    // Determine database/storage needs from manifest
    const useMySQL = manifest.databases?.mysql || false;
    const useMongo = manifest.databases?.mongo || false;
    const useRedis = manifest.databases?.redis || false;
    const useStorage = manifest.storage?.enabled || false;
    const agentPorts = manifest.ports || (manifest.agent.type === 'agidentity' ? [3000] : [8080]);
    const ingressHost = `${project.project_uuid}.${projectsDomain}`;

    // Values for the chart
    const valuesObj: any = {
      agentImage,
      frontendImage,
      ingressHostFrontend: manifest.frontend ? `frontend.${ingressHost}` : null,
      ingressCustomFrontend: project.frontend_custom_domain,
      ingressHostBackend: `agent.${ingressHost}`,
      ingressCustomBackend: project.backend_custom_domain,
      useMySQL,
      useMongo,
      useRedis,
      storage: {
        mysqlSize: '20Gi',
        mongoSize: '20Gi',
        redisSize: '5Gi',
        agentSize: manifest.storage?.size || '10Gi',
      },
    };

    fs.writeFileSync(path.join(helmDir, 'values.yaml'), JSON.stringify(valuesObj, null, 2));

    fs.ensureDirSync(path.join(helmDir, 'templates'));

    // _helpers.tpl
    fs.writeFileSync(
      path.join(helmDir, 'templates', '_helpers.tpl'),
      `{{- define "mandala-project.fullname" -}}
{{- .Release.Name -}}
{{- end }}
`
    );

    // Build env var YAML entries from mergedEnv
    let envYaml = '';
    for (const [key, value] of Object.entries(mergedEnv)) {
      envYaml += `        - name: ${key}
          value: ${JSON.stringify(String(value))}
`;
    }

    // Add blockchain-related env vars if funding is enabled
    if (project.requires_blockchain_funding) {
      envYaml += `        - name: SERVER_PRIVATE_KEY
          value: "${project.private_key}"
        - name: NETWORK
          value: "${project.network}"
`;
    }

    // Health check probes
    let livenessProbe = '';
    let readinessProbe = '';
    if (manifest.healthCheck) {
      const hcPort = manifest.healthCheck.port || agentPorts[0];
      const hcInterval = manifest.healthCheck.intervalSeconds || 30;
      livenessProbe = `
        livenessProbe:
          httpGet:
            path: ${manifest.healthCheck.path}
            port: ${hcPort}
          initialDelaySeconds: 15
          periodSeconds: ${hcInterval}`;
      readinessProbe = `
        readinessProbe:
          httpGet:
            path: ${manifest.healthCheck.path}
            port: ${hcPort}
          initialDelaySeconds: 5
          periodSeconds: ${hcInterval}`;
    }

    // Resource limits
    let resourcesYaml = `
        resources:
          requests:
            cpu: 100m`;
    if (manifest.resources) {
      const gpuLine = manifest.resources.gpu ? `\n            nvidia.com/gpu: ${manifest.resources.gpu}` : '';
      resourcesYaml = `
        resources:
          requests:
            cpu: ${manifest.resources.cpu || '100m'}
            memory: ${manifest.resources.memory || '128Mi'}${gpuLine}
          limits:
            cpu: ${manifest.resources.cpu || '1000m'}
            memory: ${manifest.resources.memory || '512Mi'}${gpuLine}`;
    }

    // Agent container ports
    const containerPortsYaml = agentPorts.map(p => `        - containerPort: ${p}`).join('\n');

    // Storage volume mount for agent
    let agentVolumeMount = '';
    let agentVolume = '';
    if (useStorage) {
      const mountPath = manifest.storage?.mountPath || '/data';
      agentVolumeMount = `
        volumeMounts:
        - name: agent-data
          mountPath: ${mountPath}`;
      agentVolume = `
      volumes:
      - name: agent-data
        persistentVolumeClaim:
          claimName: {{ include "mandala-project.fullname" . }}-agent-pvc`;
    }

    // GPU scheduling: runtimeClassName + tolerations
    let gpuSchedulingYaml = '';
    if (manifest.resources?.gpu) {
      gpuSchedulingYaml = `
      runtimeClassName: nvidia
      tolerations:
      - key: nvidia.com/gpu
        operator: Exists
        effect: NoSchedule`;
    }

    //
    // 13a) Main Deployment
    //
    fs.writeFileSync(
      path.join(helmDir, 'templates', 'deployment.yaml'),
      `apiVersion: apps/v1
kind: Deployment
metadata:
  name: {{ include "mandala-project.fullname" . }}-deployment
  labels:
    app: {{ include "mandala-project.fullname" . }}
spec:
  replicas: 1
  selector:
    matchLabels:
      app: {{ include "mandala-project.fullname" . }}
  template:
    metadata:
      labels:
        app: {{ include "mandala-project.fullname" . }}
    spec:${gpuSchedulingYaml}
      containers:
      {{- if .Values.agentImage }}
      - name: agent
        image: {{ .Values.agentImage }}
        env:
${envYaml}        ports:
${containerPortsYaml}${livenessProbe}${readinessProbe}${resourcesYaml}${agentVolumeMount}
      {{- end }}
      {{- if .Values.frontendImage }}
      - name: frontend
        image: {{ .Values.frontendImage }}
        ports:
        - containerPort: 80
        resources:
          requests:
            cpu: 100m
      {{- end }}${agentVolume}
`
    );

    //
    // 13b) HorizontalPodAutoscaler (disabled for GPU workloads — GPUs are discrete, non-overcommittable)
    //
    const hpaMaxReplicas = manifest.resources?.gpu ? 1 : 10;
    fs.writeFileSync(
      path.join(helmDir, 'templates', 'hpa.yaml'),
      `apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: {{ include "mandala-project.fullname" . }}-deployment
  labels:
    app: {{ include "mandala-project.fullname" . }}
spec:
  maxReplicas: ${hpaMaxReplicas}
  metrics:
  - resource:
      name: cpu
      target:
        averageUtilization: 50
        type: Utilization
    type: Resource
  minReplicas: 1
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: {{ include "mandala-project.fullname" . }}-deployment
`
    );

    //
    // 13c) Service
    //
    const servicePortsYaml = agentPorts.map((p, i) => `  - port: ${p}
    targetPort: ${p}
    protocol: TCP
    name: agent${i > 0 ? `-${i}` : ''}`).join('\n');

    fs.writeFileSync(
      path.join(helmDir, 'templates', 'service.yaml'),
      `apiVersion: v1
kind: Service
metadata:
  name: {{ include "mandala-project.fullname" . }}-service
  labels:
    app: {{ include "mandala-project.fullname" . }}
spec:
  clusterIP: None
  selector:
    app: {{ include "mandala-project.fullname" . }}
  ports:
  {{- if .Values.agentImage }}
${servicePortsYaml}
  {{- end }}
  {{- if .Values.frontendImage }}
  - port: 80
    targetPort: 80
    protocol: TCP
    name: frontend
  {{- end }}
`
    );

    //
    // 13d) Ingress
    //
    let tlsHosts = '';
    if (manifest.frontend) {
      tlsHosts += `      - {{ .Values.ingressHostFrontend }}\n`;
      if (valuesObj.ingressCustomFrontend) {
        tlsHosts += `      - {{ .Values.ingressCustomFrontend }}\n`;
      }
    }
    tlsHosts += `      - {{ .Values.ingressHostBackend }}\n`;
    if (valuesObj.ingressCustomBackend) {
      tlsHosts += `      - {{ .Values.ingressCustomBackend }}\n`;
    }

    // Primary ingress port for agent
    const primaryAgentPort = agentPorts[0];

    let wwwIngressYaml = '';
    if (valuesObj.ingressCustomFrontend) {
      wwwIngressYaml = `apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: {{ include "mandala-project.fullname" . }}-www
  labels:
    app: {{ include "mandala-project.fullname" . }}
    created-by: mandala
  annotations:
    cert-manager.io/cluster-issuer: "letsencrypt-production"
spec:
  ingressClassName: nginx
  tls:
    - hosts:
      - www.{{ .Values.ingressCustomFrontend }}
      secretName: project-${project.project_uuid}-www-tls
  rules:
  - host: www.{{ .Values.ingressHostFrontend }}
    http:
      paths:
      - path: /
        pathType: Prefix
        backend:
          service:
            name: {{ include "mandala-project.fullname" . }}-service
            port:
              number: 80
`;
    }

    let ingressYaml = `apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: {{ include "mandala-project.fullname" . }}-ingress
  labels:
    app: {{ include "mandala-project.fullname" . }}
    created-by: mandala
  annotations:
    cert-manager.io/cluster-issuer: "letsencrypt-production"
spec:
  ingressClassName: nginx
  tls:
    - hosts:
${tlsHosts}      secretName: project-${project.project_uuid}-tls
  rules:
`;

    if (manifest.frontend) {
      ingressYaml += `
  - host: {{ .Values.ingressHostFrontend }}
    http:
      paths:
      - path: /
        pathType: Prefix
        backend:
          service:
            name: {{ include "mandala-project.fullname" . }}-service
            port:
              number: 80
`;
      if (project.frontend_custom_domain) {
        ingressYaml += `
  - host: {{ .Values.ingressCustomFrontend }}
    http:
      paths:
      - path: /
        pathType: Prefix
        backend:
          service:
            name: {{ include "mandala-project.fullname" . }}-service
            port:
              number: 80
  - host: www.{{ .Values.ingressCustomFrontend }}
    http:
      paths:
      - path: /
        pathType: Prefix
        backend:
          service:
            name: {{ include "mandala-project.fullname" . }}-service
            port:
              number: 80
`;
      }
    }

    // Agent ingress
    ingressYaml += `
  - host: {{ .Values.ingressHostBackend }}
    http:
      paths:
      - path: /
        pathType: Prefix
        backend:
          service:
            name: {{ include "mandala-project.fullname" . }}-service
            port:
              number: ${primaryAgentPort}
`;
    if (project.backend_custom_domain) {
      ingressYaml += `
  - host: {{ .Values.ingressCustomBackend }}
    http:
      paths:
      - path: /
        pathType: Prefix
        backend:
          service:
            name: {{ include "mandala-project.fullname" . }}-service
            port:
              number: ${primaryAgentPort}
`;
    }

    fs.writeFileSync(
      path.join(helmDir, 'templates', 'ingress.yaml'),
      ingressYaml
    );

    if (valuesObj.ingressCustomFrontend && wwwIngressYaml) {
      fs.writeFileSync(
        path.join(helmDir, 'templates', 'www-ingress.yaml'),
        wwwIngressYaml
      );
    }

    //
    // 13e) MySQL StatefulSet (conditional)
    //
    fs.writeFileSync(
      path.join(helmDir, 'templates', 'mysql-statefulset.yaml'),
      `{{- if .Values.useMySQL }}
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: mysql
  labels:
    app: mysql
spec:
  selector:
    matchLabels:
      app: mysql
  serviceName: mysql-headless
  replicas: 1
  template:
    metadata:
      labels:
        app: mysql
    spec:
      containers:
        - name: mysql
          image: mysql:8.0
          env:
            - name: MYSQL_ROOT_PASSWORD
              value: "rootpassword"
            - name: MYSQL_DATABASE
              value: "projectdb"
            - name: MYSQL_USER
              value: "projectUser"
            - name: MYSQL_PASSWORD
              value: "projectPass"
            - name: MYSQL_EXTRA_FLAGS
              value: "--innodb_use_native_aio=0"
          ports:
            - containerPort: 3306
          volumeMounts:
            - name: mysql-data
              mountPath: /var/lib/mysql
      securityContext:
        fsGroup: 999
        fsGroupChangePolicy: "OnRootMismatch"
  volumeClaimTemplates:
    - metadata:
        name: mysql-data
      spec:
        accessModes: ["ReadWriteOnce"]
        resources:
          requests:
            storage: {{ .Values.storage.mysqlSize | quote }}

---
apiVersion: v1
kind: Service
metadata:
  name: mysql-headless
  labels:
    app: mysql
spec:
  clusterIP: None
  selector:
    app: mysql
  ports:
    - port: 3306
      targetPort: 3306
      protocol: TCP
      name: mysql
---
apiVersion: v1
kind: Service
metadata:
  name: mysql
  labels:
    app: mysql
spec:
  clusterIP: None
  selector:
    app: mysql
  ports:
    - port: 3306
      targetPort: 3306
      protocol: TCP
      name: mysql
{{- end }}
`
    );

    //
    // 13f) MongoDB StatefulSet (conditional)
    //
    fs.writeFileSync(
      path.join(helmDir, 'templates', 'mongo-statefulset.yaml'),
      `{{- if .Values.useMongo }}
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: mongo
  labels:
    app: mongo
spec:
  serviceName: mongo-headless
  replicas: 1
  selector:
    matchLabels:
      app: mongo
  template:
    metadata:
      labels:
        app: mongo
    spec:
      containers:
        - name: mongo
          image: mongo:6.0
          env:
            - name: MONGO_INITDB_ROOT_USERNAME
              value: "root"
            - name: MONGO_INITDB_ROOT_PASSWORD
              value: "rootpassword"
          ports:
            - containerPort: 27017
          volumeMounts:
            - name: mongo-data
              mountPath: /data/db
      securityContext:
        fsGroup: 999
        fsGroupChangePolicy: "OnRootMismatch"
  volumeClaimTemplates:
    - metadata:
        name: mongo-data
      spec:
        accessModes: ["ReadWriteOnce"]
        resources:
          requests:
            storage: {{ .Values.storage.mongoSize | quote }}

---
apiVersion: v1
kind: Service
metadata:
  name: mongo-headless
  labels:
    app: mongo
spec:
  clusterIP: None
  selector:
    app: mongo
  ports:
    - port: 27017
      targetPort: 27017
      protocol: TCP
      name: mongo
---
apiVersion: v1
kind: Service
metadata:
  name: mongo
  labels:
    app: mongo
spec:
  clusterIP: None
  selector:
    app: mongo
  ports:
    - port: 27017
      targetPort: 27017
      protocol: TCP
      name: mongo
{{- end }}
`
    );

    //
    // 13g) Redis Deployment (conditional)
    //
    fs.writeFileSync(
      path.join(helmDir, 'templates', 'redis.yaml'),
      `{{- if .Values.useRedis }}
apiVersion: apps/v1
kind: Deployment
metadata:
  name: redis
  labels:
    app: redis
spec:
  replicas: 1
  selector:
    matchLabels:
      app: redis
  template:
    metadata:
      labels:
        app: redis
    spec:
      containers:
        - name: redis
          image: redis:7-alpine
          ports:
            - containerPort: 6379
---
apiVersion: v1
kind: Service
metadata:
  name: redis
  labels:
    app: redis
spec:
  clusterIP: None
  selector:
    app: redis
  ports:
    - port: 6379
      targetPort: 6379
      protocol: TCP
      name: redis
{{- end }}
`
    );

    //
    // 13h) Agent PVC (conditional)
    //
    if (useStorage) {
      fs.writeFileSync(
        path.join(helmDir, 'templates', 'agent-pvc.yaml'),
        `apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: {{ include "mandala-project.fullname" . }}-agent-pvc
  labels:
    app: {{ include "mandala-project.fullname" . }}
spec:
  accessModes:
    - ReadWriteOnce
  resources:
    requests:
      storage: {{ .Values.storage.agentSize | quote }}
`
      );
    }

    await logStep(`Helm chart generated at ${helmDir}`);

    // 14) Deploy with Helm
    const namespace = `mandala-project-${project.project_uuid}`;
    const helmReleaseName = `mandala-project-${project.project_uuid.substr(0, 24)}`;

    runCmd(`helm upgrade --install ${helmReleaseName} ${helmDir} --namespace ${namespace} --atomic --create-namespace`);
    await logStep(`Helm release ${helmReleaseName} deployed for project ${project.project_uuid}`);

    // 15) Wait for the main deployment to roll out
    runCmd(`kubectl rollout status deployment/${helmReleaseName}-deployment -n ${namespace}`);
    await logStep(`Project ${project.project_uuid}, release ${deploymentId} rolled out successfully.`);

    // 15b) Refresh overlay advertisement — resource availability changed
    await refreshAdvertisement();

    // Log final URLs
    if (manifest.frontend) {
      await logStep(`Frontend URL: ${valuesObj.ingressHostFrontend}`);
    }
    await logStep(`Agent URL: ${valuesObj.ingressHostBackend}`);

    // Return success response
    const responseObj: any = {
      message: 'Deployment completed successfully',
      agentUrl: valuesObj.ingressHostBackend,
    };
    if (manifest.frontend) responseObj.frontendUrl = valuesObj.ingressHostFrontend;
    if (manifest.frontend && project.frontend_custom_domain) {
      responseObj.frontendCustomDomain = project.frontend_custom_domain;
    }
    if (project.backend_custom_domain) {
      responseObj.agentCustomDomain = project.backend_custom_domain;
    }

    res.json(responseObj);
  } catch (error: any) {
    // Handle errors gracefully, logging them and returning a 500
    if (deploy && project) {
      await db('logs').insert({
        project_id: project.id,
        deploy_id: deploy.id,
        message: `Error handling upload: ${error.message}`
      });
      logger.error({ deploymentId, error: error.message }, `Error handling upload: ${error.message}`);

      // Attempt to email project admins about the failure
      try {
        const admins = await db('project_admins')
          .join('users', 'users.identity_key', 'project_admins.identity_key')
          .where({ 'project_admins.project_id': project.id })
          .select('users.email', 'users.identity_key');
        const emails = admins.map((a: any) => a.email);

        const subject = `Deployment Failure for Project: ${project.name}`;
        const body = `Hello,

A deployment for project "${project.name}" (ID: ${project.project_uuid}) has failed.
Deployment ID: ${deploy.deployment_uuid}

Error Details:
${error.message}

Originated by: ${(req as any).user?.identity_key} (${(req as any).user?.email})

Please check the logs for more details.

Regards,
Mandala Network`;

        await sendDeploymentFailureEmail(emails, project, body, subject);
      } catch (ignore) {
        // ignore any email-sending errors
      }
    }

    res.status(500).json({ error: `Error handling upload: ${error.message}` });
  }
};
