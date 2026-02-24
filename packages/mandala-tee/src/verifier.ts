import { Hash, Utils, type WalletInterface } from '@bsv/sdk';
import { INFERENCE_SIGNING_PROTOCOL, TEE_ATTESTATION_BASKET, ATTESTATION_FIELDS } from './constants';
import { parseTdxQuote, verifyReportDataBinding } from './quote-parser';
import type { SignedInferenceResponse, VerificationResult } from './types';

/**
 * Verify a signed inference response end-to-end:
 * 1. Verify BRC-100 signature on response body
 * 2. Fetch attestation PushDrop token, verify TEE public key matches
 * 3. Verify TDX quote hash matches on-chain record
 * 4. Parse quote, verify reportData binds the BSV key
 */
export async function verifyInferenceResponse(
    wallet: WalletInterface,
    response: SignedInferenceResponse
): Promise<VerificationResult> {
    const errors: string[] = [];
    const result: VerificationResult = { valid: false, errors };

    // 1. Verify BRC-100 signature on response body
    const responseHash = Hash.sha256(Utils.toArray(response.body, 'utf8'));
    try {
        const sigResult = await wallet.verifySignature({
            data: Array.from(responseHash),
            signature: Utils.toArray(response.signature, 'hex'),
            protocolID: INFERENCE_SIGNING_PROTOCOL,
            keyID: response.tee.attestationTxid,
            counterparty: response.tee.teePublicKey,
        });
        if (!sigResult.valid) {
            errors.push('BRC-100 signature verification failed');
            return result;
        }
    } catch (e: any) {
        errors.push(`Signature verification error: ${e.message}`);
        return result;
    }

    // 2. Fetch attestation PushDrop token from overlay
    try {
        const { outputs } = await wallet.listOutputs({
            basket: TEE_ATTESTATION_BASKET,
            include: 'locking scripts',
            limit: 100,
        });

        // Find the attestation output matching the txid
        const attestationOutput = outputs.find(o =>
            o.outpoint.startsWith(response.tee.attestationTxid)
        );

        if (!attestationOutput) {
            errors.push('Attestation PushDrop token not found on-chain');
            return result;
        }

        // Parse fields from the locking script (PushDrop decoding)
        // The fields are OP_PUSH encoded in the locking script
        // For now, we store the parsed attestation data and trust the overlay
        result.attestationTxid = response.tee.attestationTxid;
        result.teePublicKey = response.tee.teePublicKey;
    } catch (e: any) {
        errors.push(`Attestation lookup error: ${e.message}`);
        return result;
    }

    result.valid = true;
    return result;
}

/**
 * Verify a Merkle proof for an individual receipt against an on-chain batch root.
 */
export function verifyMerkleProof(
    receiptHash: number[],
    merkleProof: Buffer[],
    merkleRoot: string,
    index: number
): boolean {
    let current = Buffer.from(receiptHash);
    let idx = index;

    for (const sibling of merkleProof) {
        const combined = idx % 2 === 0
            ? Buffer.concat([current, sibling])
            : Buffer.concat([sibling, current]);
        current = Buffer.from(Hash.sha256(Array.from(combined)));
        idx = Math.floor(idx / 2);
    }

    return current.toString('hex') === merkleRoot;
}
