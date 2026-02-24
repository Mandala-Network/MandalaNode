import { execSync } from 'child_process';
import logger from './logger';

export async function initCluster() {
    logger.info('Checking if cluster is ready...');
    for (let i = 0; i < 30; i++) {
        try {
            const output = execSync('kubectl get nodes', { encoding: 'utf-8' });
            if (output.includes('Ready')) {
                logger.info('Cluster is ready!');
                break;
            }
        } catch (e) {
            logger.warn('Cluster not ready yet, waiting...');
        }
        await new Promise(r => setTimeout(r, 5000));
    }

    // Remove any existing Traefik ingress controller if present (common in k3s)
    try {
        logger.info('Ensuring no other ingress controllers (like Traefik) exist...');
        execSync('kubectl delete helmchart traefik -n kube-system --ignore-not-found=true', { stdio: 'inherit' });
        execSync('kubectl delete deployment traefik -n kube-system --ignore-not-found=true', { stdio: 'inherit' });
        execSync('kubectl delete svc traefik -n kube-system --ignore-not-found=true', { stdio: 'inherit' });
        execSync('kubectl delete ingressclass traefik --ignore-not-found=true', { stdio: 'inherit' });
        execSync('kubectl delete ingressclass traefik-ingress-class --ignore-not-found=true', { stdio: 'inherit' });
        logger.info('All non-nginx ingress controllers removed or not found.');
    } catch (e) {
        logger.error(e, 'Failed to remove other ingress controllers');
    }

    // Install ingress-nginx and make it the default ingress class
    try {
        execSync('helm repo add ingress-nginx https://kubernetes.github.io/ingress-nginx', { stdio: 'inherit' });
        execSync('helm repo update', { stdio: 'inherit' });
        execSync('helm upgrade --install ingress-nginx ingress-nginx/ingress-nginx --create-namespace -n ingress-nginx --set controller.ingressClassResource.default=true', { stdio: 'inherit' });
        logger.info('Ingress-nginx installed or updated, set as default.');
    } catch (e) {
        logger.error(e, 'Failed to install or set ingress-nginx as default');
    }

    // Create a global namespace for Mandala if needed
    try {
        execSync('kubectl create namespace mandala-global || true', { stdio: 'inherit' });
        logger.info('mandala-global namespace ensured.');
    } catch (e) {
        logger.error(e, 'Failed to ensure mandala-global namespace');
    }

    // Install cert-manager
    try {
        execSync('helm repo add jetstack https://charts.jetstack.io', { stdio: 'inherit' });
        execSync('helm repo update', { stdio: 'inherit' });
        execSync('helm upgrade --install cert-manager jetstack/cert-manager --namespace cert-manager --create-namespace --set installCRDs=true', { stdio: 'inherit' });
        logger.info('cert-manager installed.');
    } catch (e) {
        logger.error(e, 'Failed to install cert-manager');
    }

    // Create a ClusterIssuer for Let's Encrypt
    const clusterIssuer = `
apiVersion: cert-manager.io/v1
kind: ClusterIssuer
metadata:
  name: letsencrypt-production
spec:
  acme:
    email: "${process.env.CERT_ISSUANCE_EMAIL}"
    server: "https://acme-v02.api.letsencrypt.org/directory"
    privateKeySecretRef:
      name: letsencrypt-production
    solvers:
      - http01:
          ingress:
            class: nginx
`;
    try {
        execSync('kubectl apply -f -', {
            input: clusterIssuer,
            stdio: ['pipe', 'inherit', 'inherit']
        });
        logger.info('ClusterIssuer letsencrypt-production created.');
    } catch (e) {
        logger.error(e, 'Failed to create ClusterIssuer for Let\'s Encrypt');
    }

    // Install kube-prometheus-stack for metrics and monitoring
    try {
        execSync('helm repo add prometheus-community https://prometheus-community.github.io/helm-charts', { stdio: 'inherit' });
        execSync('helm repo update', { stdio: 'inherit' });
        execSync(`
          helm upgrade --install kube-prometheus-stack prometheus-community/kube-prometheus-stack \
          --create-namespace -n monitoring \
          --set prometheus.prometheusSpec.serviceMonitorSelectorNilUsesHelmValues=false \
          --set prometheus.prometheusSpec.podMonitorSelectorNilUsesHelmValues=false \
          --set global.scrape_interval=30s \
          --set global.scrape_timeout=10s
        `, { stdio: 'inherit' });

        logger.info('kube-prometheus-stack installed. Prometheus now scrapes the cluster metrics.');
    } catch (e) {
        logger.error(e, 'Failed to install kube-prometheus-stack');
    }

    // Configure Prometheus ingress
    try {
        const projectsDomain = process.env.PROJECT_DEPLOYMENT_DNS_NAME!;
        const ingressYaml = `
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: prometheus-ingress
  namespace: monitoring
  annotations:
    cert-manager.io/cluster-issuer: "letsencrypt-production"
    nginx.ingress.kubernetes.io/force-ssl-redirect: "false"
    nginx.ingress.kubernetes.io/ssl-redirect: "false"
spec:
  ingressClassName: nginx
  tls:
    - hosts:
      - prometheus.${projectsDomain}
      secretName: prometheus-tls
  rules:
    - host: prometheus.${projectsDomain}
      http:
        paths:
          - path: /
            pathType: Prefix
            backend:
              service:
                name: kube-prometheus-stack-prometheus
                port:
                  number: 9090
`;

        execSync('kubectl apply -f -', {
            input: ingressYaml,
            stdio: ['pipe', 'inherit', 'inherit']
        });

        logger.info('Prometheus ingress applied. Prometheus now available externally at prometheus.' + projectsDomain);
    } catch (e) {
        logger.error(e, 'Failed to apply Prometheus ingress');
    }

    // Conditionally install NVIDIA GPU infrastructure
    if (process.env.GPU_ENABLED === 'true') {
        logger.info('GPU_ENABLED=true — installing NVIDIA GPU infrastructure...');

        // Install NVIDIA Device Plugin (makes K8s aware of nvidia.com/gpu resources)
        try {
            execSync('helm repo add nvdp https://nvidia.github.io/k8s-device-plugin', { stdio: 'inherit' });
            execSync('helm repo update', { stdio: 'inherit' });
            execSync('helm upgrade --install nvidia-device-plugin nvdp/nvidia-device-plugin --namespace nvidia-device-plugin --create-namespace', { stdio: 'inherit' });
            logger.info('NVIDIA device plugin installed.');
        } catch (e) {
            logger.error(e, 'Failed to install NVIDIA device plugin');
        }

        // Install DCGM Exporter (GPU metrics for Prometheus)
        try {
            execSync('helm repo add gpu-helm-charts https://nvidia.github.io/dcgm-exporter/helm-charts', { stdio: 'inherit' });
            execSync('helm repo update', { stdio: 'inherit' });
            execSync('helm upgrade --install dcgm-exporter gpu-helm-charts/dcgm-exporter --namespace monitoring --create-namespace --set serviceMonitor.enabled=true', { stdio: 'inherit' });
            logger.info('DCGM exporter installed with ServiceMonitor enabled.');
        } catch (e) {
            logger.error(e, 'Failed to install DCGM exporter');
        }

        // Create RuntimeClass for NVIDIA (required for pods to use NVIDIA container runtime)
        try {
            const runtimeClassYaml = `
apiVersion: node.k8s.io/v1
kind: RuntimeClass
metadata:
  name: nvidia
handler: nvidia
`;
            execSync('kubectl apply -f -', {
                input: runtimeClassYaml,
                stdio: ['pipe', 'inherit', 'inherit']
            });
            logger.info('RuntimeClass "nvidia" created.');
        } catch (e) {
            logger.error(e, 'Failed to create NVIDIA RuntimeClass');
        }
    }

    // Conditionally install TEE (Confidential Computing) infrastructure
    if (process.env.TEE_ENABLED === 'true') {
        logger.info('TEE_ENABLED=true — installing TEE infrastructure...');
        const teeTechnology = process.env.TEE_TECHNOLOGY || 'tdx';

        // Install Confidential Containers operator
        try {
            execSync('helm repo add confidential-containers https://confidential-containers.github.io/operator', { stdio: 'inherit' });
            execSync('helm repo update', { stdio: 'inherit' });
            execSync('helm upgrade --install cc-operator confidential-containers/cc-operator --namespace confidential-containers-system --create-namespace', { stdio: 'inherit' });
            logger.info('Confidential Containers operator installed.');
        } catch (e) {
            logger.error(e, 'Failed to install Confidential Containers operator');
        }

        // Create RuntimeClass for kata-cc-tdx
        try {
            const runtimeClassYaml = `
apiVersion: node.k8s.io/v1
kind: RuntimeClass
metadata:
  name: kata-cc-tdx
handler: kata-cc-tdx
scheduling:
  nodeSelector:
    node.kubernetes.io/tee: "${teeTechnology}"
`;
            execSync('kubectl apply -f -', {
                input: runtimeClassYaml,
                stdio: ['pipe', 'inherit', 'inherit']
            });
            logger.info('RuntimeClass "kata-cc-tdx" created.');
        } catch (e) {
            logger.error(e, 'Failed to create kata-cc-tdx RuntimeClass');
        }

        // Label TEE-capable nodes (if node labels aren't already set externally)
        try {
            const nodesJson = execSync('kubectl get nodes -o json', { encoding: 'utf-8' });
            const nodes = JSON.parse(nodesJson);
            for (const node of nodes.items) {
                const nodeName = node.metadata?.name;
                const existing = node.metadata?.labels?.['node.kubernetes.io/tee'];
                if (!existing && nodeName) {
                    // Check if the node has /dev/tdx-guest (TDX) via node info
                    // In production, nodes should be pre-labeled; this is a best-effort fallback
                    logger.debug(`Node ${nodeName} does not have TEE label, skipping auto-label`);
                }
            }
        } catch (e) {
            logger.warn('Could not check node TEE labels');
        }

        // Deploy tappd DaemonSet to mandala-global namespace
        try {
            const tappdDaemonSetYaml = `
apiVersion: apps/v1
kind: DaemonSet
metadata:
  name: tappd
  namespace: mandala-global
  labels:
    app: tappd
spec:
  selector:
    matchLabels:
      app: tappd
  template:
    metadata:
      labels:
        app: tappd
    spec:
      hostNetwork: true
      nodeSelector:
        node.kubernetes.io/tee: "${teeTechnology}"
      tolerations:
      - key: node.kubernetes.io/tee
        operator: Exists
        effect: NoSchedule
      containers:
      - name: tappd
        image: ghcr.io/aspect-build/dstack-tappd:latest
        securityContext:
          privileged: true
        ports:
        - containerPort: 8090
          hostPort: 8090
        volumeMounts:
        - name: tdx-guest
          mountPath: /dev/tdx-guest
      volumes:
      - name: tdx-guest
        hostPath:
          path: /dev/tdx-guest
          type: CharDevice
`;
            execSync('kubectl apply -f -', {
                input: tappdDaemonSetYaml,
                stdio: ['pipe', 'inherit', 'inherit']
            });
            logger.info('tappd DaemonSet deployed to mandala-global namespace.');
        } catch (e) {
            logger.error(e, 'Failed to deploy tappd DaemonSet');
        }
    }
}
