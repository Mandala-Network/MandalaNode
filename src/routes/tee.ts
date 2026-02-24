import { Router } from 'express';
import type { Knex } from 'knex';
import type { WalletInterface } from '@bsv/sdk';
import logger from '../logger';
import { fundKey } from '../utils/wallet';

const router = Router();

const TEE_ENABLED = process.env.TEE_ENABLED === 'true';
const TEE_TECHNOLOGY = process.env.TEE_TECHNOLOGY || 'tdx';

/**
 * GET /tee/status
 * Public — returns node TEE capabilities.
 */
router.get('/status', async (_req, res) => {
    try {
        res.json({
            enabled: TEE_ENABLED,
            technology: TEE_ENABLED ? TEE_TECHNOLOGY : null,
            supportedTechnologies: TEE_ENABLED ? [TEE_TECHNOLOGY] : [],
        });
    } catch (e: any) {
        logger.error(e, 'Error fetching TEE status');
        res.status(500).json({ error: 'Failed to fetch TEE status' });
    }
});

/**
 * GET /tee/attestation/current
 * Public — returns the current (most recent) attestation record.
 */
router.get('/attestation/current', async (req, res) => {
    const db: Knex = (req as any).db;
    try {
        const attestation = await db('tee_attestations')
            .where({ is_current: true })
            .first();
        if (!attestation) {
            return res.status(404).json({ error: 'No current attestation found' });
        }
        res.json(attestation);
    } catch (e: any) {
        logger.error(e, 'Error fetching current attestation');
        res.status(500).json({ error: 'Failed to fetch attestation' });
    }
});

/**
 * GET /tee/attestation/:txid
 * Public — returns a specific attestation by transaction ID.
 */
router.get('/attestation/:txid', async (req, res) => {
    const db: Knex = (req as any).db;
    const { txid } = req.params;
    try {
        const attestation = await db('tee_attestations')
            .where({ attestation_txid: txid })
            .first();
        if (!attestation) {
            return res.status(404).json({ error: 'Attestation not found' });
        }
        res.json(attestation);
    } catch (e: any) {
        logger.error(e, 'Error fetching attestation');
        res.status(500).json({ error: 'Failed to fetch attestation' });
    }
});

/**
 * POST /tee/verify/attestation
 * Authenticated — verify an attestation chain.
 * Body: { attestationTxid: string }
 */
router.post('/verify/attestation', async (req, res) => {
    const db: Knex = (req as any).db;
    const { attestationTxid } = req.body;

    if (!attestationTxid) {
        return res.status(400).json({ error: 'attestationTxid is required' });
    }

    try {
        const attestation = await db('tee_attestations')
            .where({ attestation_txid: attestationTxid })
            .first();
        if (!attestation) {
            return res.status(404).json({ error: 'Attestation not found' });
        }

        // Basic verification: check that the record exists and is well-formed
        const checks = {
            recordExists: true,
            hasNodeIdentityKey: !!attestation.node_identity_key,
            hasTeePublicKey: !!attestation.tee_public_key,
            hasTdxQuoteHash: !!attestation.tdx_quote_hash,
            hasMrEnclave: !!attestation.mr_enclave,
            teeTechnology: attestation.tee_technology,
            isCurrent: attestation.is_current,
        };

        const valid = checks.hasNodeIdentityKey && checks.hasTeePublicKey && checks.hasTdxQuoteHash && checks.hasMrEnclave;

        res.json({
            valid,
            attestation,
            checks,
        });
    } catch (e: any) {
        logger.error(e, 'Error verifying attestation');
        res.status(500).json({ error: 'Verification failed' });
    }
});

/**
 * POST /tee/verify/receipt
 * Authenticated — verify an inference receipt + Merkle proof.
 * Body: { batchTxid: string, receiptHash: string, merkleProof: string[], index: number }
 */
router.post('/verify/receipt', async (req, res) => {
    const db: Knex = (req as any).db;
    const { batchTxid, receiptHash, merkleProof, index } = req.body;

    if (!batchTxid || !receiptHash || !merkleProof || index === undefined) {
        return res.status(400).json({ error: 'batchTxid, receiptHash, merkleProof, and index are required' });
    }

    try {
        const batch = await db('inference_receipt_batches')
            .where({ batch_txid: batchTxid })
            .first();
        if (!batch) {
            return res.status(404).json({ error: 'Receipt batch not found' });
        }

        // Verify Merkle proof
        const { verifyMerkleProof } = await import('../../packages/mandala-tee/src/verifier');
        const receiptBuf = Array.from(Buffer.from(receiptHash, 'hex'));
        const proofBufs = (merkleProof as string[]).map((p: string) => Buffer.from(p, 'hex'));
        const valid = verifyMerkleProof(receiptBuf, proofBufs, batch.merkle_root, index);

        res.json({
            valid,
            batch: {
                batchTxid: batch.batch_txid,
                merkleRoot: batch.merkle_root,
                receiptCount: batch.receipt_count,
                attestationTxid: batch.attestation_txid,
            },
        });
    } catch (e: any) {
        logger.error(e, 'Error verifying receipt');
        res.status(500).json({ error: 'Verification failed' });
    }
});

/**
 * GET /tee/receipts/:projectId
 * Authenticated — list receipt batches for a project.
 */
router.get('/receipts/:projectId', async (req, res) => {
    const db: Knex = (req as any).db;
    const { projectId } = req.params;
    try {
        // Get the node identity key for this project's attestation
        const project = await db('projects')
            .where({ project_uuid: projectId })
            .first();
        if (!project) {
            return res.status(404).json({ error: 'Project not found' });
        }

        const batches = await db('inference_receipt_batches')
            .orderBy('created_at', 'desc')
            .limit(100);

        res.json({ batches });
    } catch (e: any) {
        logger.error(e, 'Error listing receipt batches');
        res.status(500).json({ error: 'Failed to list receipt batches' });
    }
});

/**
 * POST /tee/fund-proxy
 * Internal — CVM proxy requests funding for its BSV wallet.
 * Body: { address: string, publicKey: string, amount?: number }
 */
router.post('/fund-proxy', async (req, res) => {
    const wallet: WalletInterface = (req as any).mainnetWallet;
    const { address, publicKey, amount } = req.body;

    if (!address || !publicKey) {
        return res.status(400).json({ error: 'address and publicKey are required' });
    }

    const fundingAmount = amount || 1000; // Default 1000 sats

    try {
        // Use the wallet to send funds to the proxy's address
        // The proxy provides its public key; we create a simple P2PKH output
        const { P2PKH, PublicKey: PubKey } = await import('@bsv/sdk');
        const lockingScript = new P2PKH().lock(PubKey.fromString(publicKey).toAddress()).toHex();

        await wallet.createAction({
            description: 'Fund TEE inference proxy wallet',
            outputs: [{
                lockingScript,
                satoshis: fundingAmount,
                outputDescription: 'TEE proxy funding',
            }],
        });

        logger.info({ publicKey, amount: fundingAmount }, 'Funded TEE proxy wallet');
        res.json({ funded: true, amount: fundingAmount });
    } catch (e: any) {
        logger.error(e, 'Error funding TEE proxy');
        res.status(500).json({ error: 'Failed to fund proxy wallet' });
    }
});

/**
 * POST /tee/attestation/register
 * Internal — CVM proxy registers a new attestation.
 * Body: { attestationTxid, nodeIdentityKey, teePublicKey, tdxQuoteHash,
 *         mrEnclave, mrSigner, gpuEvidenceHash?, teeTechnology, attestedAt }
 */
router.post('/attestation/register', async (req, res) => {
    const db: Knex = (req as any).db;
    const {
        attestationTxid, nodeIdentityKey, teePublicKey, tdxQuoteHash,
        mrEnclave, mrSigner, gpuEvidenceHash, teeTechnology, attestedAt
    } = req.body;

    if (!attestationTxid || !nodeIdentityKey || !teePublicKey || !tdxQuoteHash || !mrEnclave || !mrSigner || !teeTechnology) {
        return res.status(400).json({ error: 'Missing required attestation fields' });
    }

    try {
        // Mark all previous attestations as not current
        await db('tee_attestations')
            .where({ node_identity_key: nodeIdentityKey, is_current: true })
            .update({ is_current: false });

        // Insert new attestation
        await db('tee_attestations').insert({
            attestation_txid: attestationTxid,
            node_identity_key: nodeIdentityKey,
            tee_public_key: teePublicKey,
            tdx_quote_hash: tdxQuoteHash,
            mr_enclave: mrEnclave,
            mr_signer: mrSigner,
            gpu_evidence_hash: gpuEvidenceHash || null,
            tee_technology: teeTechnology,
            is_current: true,
            attested_at: attestedAt || new Date().toISOString(),
        });

        logger.info({ attestationTxid, teePublicKey }, 'Registered new TEE attestation');
        res.json({ registered: true, attestationTxid });
    } catch (e: any) {
        logger.error(e, 'Error registering attestation');
        res.status(500).json({ error: 'Failed to register attestation' });
    }
});

/**
 * POST /tee/receipts/register
 * Internal — CVM proxy registers a receipt batch.
 * Body: { batchTxid, merkleRoot, receiptCount, nodeIdentityKey, attestationTxid }
 */
router.post('/receipts/register', async (req, res) => {
    const db: Knex = (req as any).db;
    const { batchTxid, merkleRoot, receiptCount, nodeIdentityKey, attestationTxid } = req.body;

    if (!batchTxid || !merkleRoot || !receiptCount || !nodeIdentityKey || !attestationTxid) {
        return res.status(400).json({ error: 'Missing required receipt batch fields' });
    }

    try {
        await db('inference_receipt_batches').insert({
            batch_txid: batchTxid,
            merkle_root: merkleRoot,
            receipt_count: receiptCount,
            node_identity_key: nodeIdentityKey,
            attestation_txid: attestationTxid,
        });

        logger.info({ batchTxid, receiptCount }, 'Registered receipt batch');
        res.json({ registered: true, batchTxid });
    } catch (e: any) {
        logger.error(e, 'Error registering receipt batch');
        res.status(500).json({ error: 'Failed to register receipt batch' });
    }
});

export default router;
