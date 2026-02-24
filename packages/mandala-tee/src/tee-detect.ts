import { execSync } from 'child_process';
import type { TeeNodeInfo } from './types';

/**
 * Detect TEE hardware capabilities in the K8s cluster via kubectl.
 */
export function detectTeeHardware(): TeeNodeInfo {
    const result: TeeNodeInfo = {
        hasTdx: false,
        hasSevSnp: false,
        technology: null,
        nodeCount: 0,
    };

    try {
        const nodesJson = execSync(
            'kubectl get nodes -l node.kubernetes.io/tee -o json',
            { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }
        );
        const nodes = JSON.parse(nodesJson);

        for (const node of nodes.items || []) {
            const teeLabel = node.metadata?.labels?.['node.kubernetes.io/tee'];
            if (teeLabel === 'tdx') result.hasTdx = true;
            if (teeLabel === 'sev-snp') result.hasSevSnp = true;
            result.nodeCount++;
        }

        if (result.hasTdx) result.technology = 'tdx';
        else if (result.hasSevSnp) result.technology = 'sev-snp';
    } catch {
        // No TEE nodes or kubectl not available
    }

    return result;
}
