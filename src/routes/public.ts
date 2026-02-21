import { ProtoWallet, PrivateKey } from '@bsv/sdk';

export default async (_, res) => {
    const mainnetKey = process.env.MAINNET_PRIVATE_KEY || '';
    const testnetKey = process.env.TESTNET_PRIVATE_KEY || '';
    const projectDomain = process.env.PROJECT_DEPLOYMENT_DNS_NAME || 'example.com';

    const cpuRate = parseInt(process.env.CPU_RATE_PER_CORE_5MIN || "1000", 10);
    const memRate = parseInt(process.env.MEM_RATE_PER_GB_5MIN || "500", 10);
    const diskRate = parseInt(process.env.DISK_RATE_PER_GB_5MIN || "10", 10);
    const netRate = parseInt(process.env.NET_RATE_PER_GB_5MIN || "200", 10);

    const mainnetWallet = new ProtoWallet(new PrivateKey(mainnetKey, 16));
    const testnetWallet = new ProtoWallet(new PrivateKey(testnetKey, 16));

    const mainnetPubKey = await mainnetWallet.getPublicKey({ identityKey: true });
    const testnetPubKey = await testnetWallet.getPublicKey({ identityKey: true });

    res.json({
        network: 'mandala',
        platform: 'mandala-network-node',
        description: 'Distributed AGiD hosting node',
        supportedAgentTypes: ['agidentity', 'openclaw', 'custom'],
        supportedRuntimes: ['node', 'python', 'docker'],
        mainnetPublicKey: mainnetPubKey,
        testnetPublicKey: testnetPubKey,
        pricing: {
            currency: 'BSV satoshis',
            interval: '5 minutes',
            cpu_rate_per_core: cpuRate,
            mem_rate_per_gb: memRate,
            disk_rate_per_gb: diskRate,
            net_rate_per_gb: netRate
        },
        projectDeploymentDomain: projectDomain
    });
}
