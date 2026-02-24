export type TeeTechnology = 'tdx' | 'sev-snp';

export interface TeeAttestation {
    id?: number;
    attestationTxid: string;
    nodeIdentityKey: string;
    teePublicKey: string;
    tdxQuoteHash: string;
    mrEnclave: string;
    mrSigner: string;
    gpuEvidenceHash: string | null;
    teeTechnology: TeeTechnology;
    isCurrent: boolean;
    attestedAt: string;
    createdAt?: string;
}

export interface InferenceReceiptBatch {
    id?: number;
    batchTxid: string;
    merkleRoot: string;
    receiptCount: number;
    nodeIdentityKey: string;
    attestationTxid: string;
    createdAt?: string;
}

export interface SignedInferenceResponse {
    body: string;
    signature: string;
    tee: {
        teePublicKey: string;
        attestationTxid: string;
    };
}

export interface AttestationReport {
    signing_identity_key: string;
    intel_quote: string;
    nvidia_payload: Record<string, unknown> | null;
    event_log: unknown[];
    info: Record<string, unknown>;
    bsv_attestation_signature: string;
}

export interface SignatureResponse {
    text: string;
    signature: string;
    signing_identity_key: string;
    protocolID: [0 | 1 | 2, string];
    keyID: string;
}

export interface VerificationResult {
    valid: boolean;
    teePublicKey?: string;
    mrEnclave?: string;
    mrSigner?: string;
    teeTechnology?: TeeTechnology;
    attestationTxid?: string;
    errors: string[];
}

export interface TeeCapabilities {
    enabled: boolean;
    technology: TeeTechnology | null;
    attestationTxid: string | null;
    rate_per_vm_5min: number;
}

export interface TeeNodeInfo {
    hasTdx: boolean;
    hasSevSnp: boolean;
    technology: TeeTechnology | null;
    nodeCount: number;
}
