import { PushDrop, WalletInterface, LockingScript } from '@bsv/sdk';
import { execSync } from 'child_process';
import logger from '../logger';

let currentWallet: WalletInterface | null = null;

/**
 * Initialize the registry module with the node's mainnet wallet.
 * Called once during server startup.
 */
export function initRegistry(wallet: WalletInterface) {
  currentWallet = wallet;
}

/**
 * Get GPU availability from the K8s cluster.
 */
function getGpuInfo(): { total: number; available: number } {
  let totalGpus = 0;
  let usedGpus = 0;

  try {
    const nodesJson = execSync('kubectl get nodes -o json', { encoding: 'utf-8' });
    const nodes = JSON.parse(nodesJson);
    for (const node of nodes.items) {
      const allocatable = node.status?.allocatable?.['nvidia.com/gpu'];
      if (allocatable) totalGpus += parseInt(allocatable, 10);
    }

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
      // pod query failed
    }
  } catch {
    // node query failed
  }

  return { total: totalGpus, available: Math.max(0, totalGpus - usedGpus) };
}

/**
 * Publish (or update) the node's capability advertisement to the BSV overlay.
 *
 * Uses PushDrop tokens on the `tm_mandala_registry` topic.
 * If an existing advertisement token exists in the `mandala_node_ads` basket,
 * it is spent and replaced with an updated token in the same transaction.
 */
export async function publishNodeAdvertisement(wallet: WalletInterface): Promise<void> {
  const gpuEnabled = process.env.GPU_ENABLED === 'true';
  const gpuInfo = gpuEnabled ? getGpuInfo() : { total: 0, available: 0 };

  const capabilities = {
    gpu: gpuEnabled,
    gpuType: process.env.GPU_TYPE || undefined,
    gpuTotal: gpuInfo.total,
    gpuAvailable: gpuInfo.available,
    supportedAgentTypes: ['agidentity', 'openclaw', 'custom'],
    supportedRuntimes: ['node', 'python', 'docker'],
  };

  const pricing = {
    cpu_rate_per_core_5min: parseInt(process.env.CPU_RATE_PER_CORE_5MIN || '1000'),
    mem_rate_per_gb_5min: parseInt(process.env.MEM_RATE_PER_GB_5MIN || '500'),
    gpu_rate_per_unit_5min: parseInt(process.env.GPU_RATE_PER_UNIT_5MIN || '5000'),
  };

  const { publicKey: identityKey } = await wallet.getPublicKey({ identityKey: true });

  const fields = [
    'mandala-node-v1',
    process.env.MANDALA_NODE_SERVER_BASEURL || 'http://localhost:7777',
    identityKey,
    JSON.stringify(capabilities),
    JSON.stringify(pricing),
    'node,python,docker',
    new Date().toISOString(),
  ];

  const protocolID: [0 | 1 | 2, string] = [2, 'mandala node registry'];
  const keyID = '1';
  const counterparty = 'anyone';

  const pushDrop = new PushDrop(wallet);
  const fieldBuffers = fields.map(f => Array.from(Buffer.from(f, 'utf-8')));

  // Check for existing advertisement token to spend (update pattern)
  let inputsToSpend: any[] = [];
  try {
    const { outputs } = await wallet.listOutputs({
      basket: 'mandala_node_ads',
      include: 'locking scripts',
      limit: 10,
    });

    if (outputs.length > 0) {
      // Spend all existing advertisement outputs (should be just one)
      for (const output of outputs) {
        const unlockTemplate = pushDrop.unlock(
          protocolID,
          keyID,
          counterparty,
          'all',
          false,
          output.satoshis,
          LockingScript.fromHex(output.lockingScript as string)
        );
        inputsToSpend.push({
          outpoint: output.outpoint,
          unlockingScriptTemplate: unlockTemplate,
          inputDescription: 'Spend previous node advertisement',
        });
      }
    }
  } catch (e) {
    // No existing outputs, creating fresh
    logger.debug('No existing advertisement token found, creating new one');
  }

  // Create new advertisement locking script
  const lockingScript = await pushDrop.lock(
    fieldBuffers,
    protocolID,
    keyID,
    counterparty,
    true
  );

  await wallet.createAction({
    description: 'Mandala node capability advertisement',
    inputs: inputsToSpend.length > 0 ? inputsToSpend : undefined,
    outputs: [{
      lockingScript: lockingScript.toHex(),
      satoshis: 1,
      outputDescription: 'Node advertisement token',
      basket: 'mandala_node_ads',
      customInstructions: JSON.stringify({
        tags: ['mandala_node_ads'],
        outputIndex: 0,
      }),
    }],
  });

  logger.info({ identityKey }, 'Published node advertisement to overlay');
}

/**
 * Refresh the node's overlay advertisement.
 * Safe to call from anywhere — silently no-ops if registry is disabled or wallet not initialized.
 */
export async function refreshAdvertisement(): Promise<void> {
  if (process.env.REGISTRY_ENABLED === 'false') return;
  if (!currentWallet) return;

  try {
    await publishNodeAdvertisement(currentWallet);
    logger.info('Refreshed node advertisement (resource change)');
  } catch (e) {
    logger.error(e, 'Failed to refresh node advertisement');
  }
}
