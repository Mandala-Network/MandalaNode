/**
 * Protocol IDs, baskets, and topics for TEE attestation.
 * These MUST match the Python side (vllm-proxy) exactly.
 */

export const TEE_ATTESTATION_PROTOCOL: [0 | 1 | 2, string] = [2, 'mandala tee attestation'];
export const TEE_ATTESTATION_BASKET = 'mandala_tee_attestations';

export const INFERENCE_RECEIPT_PROTOCOL: [0 | 1 | 2, string] = [2, 'mandala inference receipt'];
export const INFERENCE_RECEIPT_BASKET = 'mandala_inference_receipts';

export const INFERENCE_SIGNING_PROTOCOL: [0 | 1 | 2, string] = [2, 'mandala inference signing'];

export const TEE_ATTESTATION_MARKER = 'mandala-tee-attestation-v1';
export const INFERENCE_BATCH_MARKER = 'mandala-inference-batch-v1';

/** PushDrop field indices for TEE attestation tokens */
export const ATTESTATION_FIELDS = {
    MARKER: 0,
    NODE_IDENTITY_KEY: 1,
    TEE_PUBLIC_KEY: 2,
    TDX_QUOTE_HASH: 3,
    MR_ENCLAVE: 4,
    MR_SIGNER: 5,
    GPU_EVIDENCE_HASH: 6,
    TEE_TECHNOLOGY: 7,
    TIMESTAMP: 8,
} as const;

/** PushDrop field indices for inference receipt batch tokens */
export const BATCH_FIELDS = {
    MARKER: 0,
    MERKLE_ROOT: 1,
    RECEIPT_COUNT: 2,
    NODE_IDENTITY_KEY: 3,
    TEE_PUBLIC_KEY: 4,
    ATTESTATION_REF_ID: 5,
    SIGNATURE: 6,
    TIMESTAMP: 7,
} as const;
