import { ProtoWallet, PrivateKey } from '@bsv/sdk';
import { execSync } from 'child_process';

export default async (_, res) => {
    const mainnetKey = process.env.MAINNET_PRIVATE_KEY || '';
    const testnetKey = process.env.TESTNET_PRIVATE_KEY || '';
    const projectDomain = process.env.PROJECT_DEPLOYMENT_DNS_NAME || 'example.com';

    const cpuRate = parseInt(process.env.CPU_RATE_PER_CORE_5MIN || "1000", 10);
    const memRate = parseInt(process.env.MEM_RATE_PER_GB_5MIN || "500", 10);
    const diskRate = parseInt(process.env.DISK_RATE_PER_GB_5MIN || "10", 10);
    const netRate = parseInt(process.env.NET_RATE_PER_GB_5MIN || "200", 10);
    const gpuEnabled = process.env.GPU_ENABLED === 'true';
    const gpuType = process.env.GPU_TYPE || '';
    const gpuRate = parseInt(process.env.GPU_RATE_PER_UNIT_5MIN || "5000", 10);

    const mainnetWallet = new ProtoWallet(new PrivateKey(mainnetKey, 16));
    const testnetWallet = new ProtoWallet(new PrivateKey(testnetKey, 16));

    const mainnetPubKey = await mainnetWallet.getPublicKey({ identityKey: true });
    const testnetPubKey = await testnetWallet.getPublicKey({ identityKey: true });

    // Query K8s nodes once for all capability/GPU info
    let gpuInfo: any = { enabled: false };
    let maxCpu = 'unknown';
    let maxMemory = 'unknown';

    try {
        const nodesJson = execSync('kubectl get nodes -o json', { encoding: 'utf-8' });
        const nodes = JSON.parse(nodesJson);

        let totalGpus = 0;
        let totalCpuMillis = 0;
        let totalMemBytes = 0;

        for (const node of nodes.items) {
            const cpu = node.status?.allocatable?.cpu;
            const mem = node.status?.allocatable?.memory;
            if (cpu) {
                totalCpuMillis += cpu.endsWith('m') ? parseInt(cpu) : parseInt(cpu) * 1000;
            }
            if (mem) {
                if (mem.endsWith('Ki')) totalMemBytes += parseInt(mem) * 1024;
                else if (mem.endsWith('Mi')) totalMemBytes += parseInt(mem) * 1024 * 1024;
                else if (mem.endsWith('Gi')) totalMemBytes += parseInt(mem) * 1024 * 1024 * 1024;
                else totalMemBytes += parseInt(mem);
            }
            if (gpuEnabled) {
                const allocatable = node.status?.allocatable?.['nvidia.com/gpu'];
                if (allocatable) totalGpus += parseInt(allocatable, 10);
            }
        }

        maxCpu = `${totalCpuMillis}m`;
        maxMemory = `${Math.round(totalMemBytes / (1024 * 1024 * 1024))}Gi`;

        if (gpuEnabled) {
            let usedGpus = 0;
            try {
                const podsJson = execSync('kubectl get pods --all-namespaces -o json', { encoding: 'utf-8' });
                const pods = JSON.parse(podsJson);
                for (const pod of pods.items) {
                    if (pod.status?.phase !== 'Running' && pod.status?.phase !== 'Pending') continue;
                    for (const container of (pod.spec?.containers || [])) {
                        const gpuReq = container.resources?.requests?.['nvidia.com/gpu'];
                        if (gpuReq) usedGpus += parseInt(gpuReq, 10);
                    }
                }
            } catch {
                // pod query failed, assume all GPUs available
            }
            gpuInfo = {
                enabled: true,
                type: gpuType,
                total: totalGpus,
                available: Math.max(0, totalGpus - usedGpus),
                rate_per_unit_5min: gpuRate
            };
        }
    } catch {
        // K8s query failed
    }

    res.json({
        network: 'mandala',
        platform: 'mandala-network-node',
        description: 'Distributed AGiD hosting node',
        version: '1.3.0',
        nodeId: mainnetPubKey.publicKey,
        schemaVersionsSupported: ['1.0', '2.0'],
        supportedAgentTypes: ['agidentity', 'openclaw', 'custom'],
        supportedRuntimes: ['node', 'python', 'docker'],
        mainnetPublicKey: mainnetPubKey,
        testnetPublicKey: testnetPubKey,
        capabilities: {
            maxCpu,
            maxMemory,
            gpu: gpuInfo
        },
        pricing: {
            currency: 'BSV satoshis',
            interval: '5 minutes',
            cpu_rate_per_core: cpuRate,
            mem_rate_per_gb: memRate,
            disk_rate_per_gb: diskRate,
            net_rate_per_gb: netRate,
            ...(gpuEnabled ? { gpu_rate_per_unit: gpuRate } : {})
        },
        gpu: gpuInfo,
        projectDeploymentDomain: projectDomain
    });
}
