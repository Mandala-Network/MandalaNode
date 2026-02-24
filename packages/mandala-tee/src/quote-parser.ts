/**
 * TDX DCAP quote parsing utilities.
 *
 * A TDX DCAP quote (v4) has a well-known binary layout. This parser extracts
 * the fields needed for verification without depending on a native DCAP library.
 *
 * Reference: Intel TDX DCAP Quote Generation Library, Quote Format v4
 */

export interface ParsedTdxQuote {
    version: number;
    attestKeyType: number;
    teeTcbSvn: Buffer;
    mrSeam: string;
    mrSignerSeam: string;
    seamAttributes: Buffer;
    tdAttributes: Buffer;
    xfam: Buffer;
    mrTd: string;       // MR_ENCLAVE equivalent for TDX
    mrConfigId: string;
    mrOwner: string;
    mrOwnerConfig: string;
    rtMr0: string;
    rtMr1: string;
    rtMr2: string;
    rtMr3: string;
    reportData: string;  // 64 bytes: first 32 = SHA256(pubkey), last 32 = zeros
}

const HEADER_SIZE = 48;
const TD_REPORT_OFFSET = HEADER_SIZE;

/**
 * Parse a raw TDX DCAP quote (v4) from a Buffer.
 * Returns null if the buffer is too small or the version is unexpected.
 */
export function parseTdxQuote(raw: Buffer): ParsedTdxQuote | null {
    if (raw.length < HEADER_SIZE + 584) return null;

    const version = raw.readUInt16LE(0);
    if (version !== 4) return null;

    const attestKeyType = raw.readUInt16LE(2);

    const teeTcbSvn = raw.subarray(TD_REPORT_OFFSET, TD_REPORT_OFFSET + 16);
    const mrSeam = raw.subarray(TD_REPORT_OFFSET + 16, TD_REPORT_OFFSET + 64).toString('hex');
    const mrSignerSeam = raw.subarray(TD_REPORT_OFFSET + 64, TD_REPORT_OFFSET + 112).toString('hex');
    const seamAttributes = raw.subarray(TD_REPORT_OFFSET + 112, TD_REPORT_OFFSET + 120);
    const tdAttributes = raw.subarray(TD_REPORT_OFFSET + 120, TD_REPORT_OFFSET + 128);
    const xfam = raw.subarray(TD_REPORT_OFFSET + 128, TD_REPORT_OFFSET + 136);
    const mrTd = raw.subarray(TD_REPORT_OFFSET + 136, TD_REPORT_OFFSET + 184).toString('hex');
    const mrConfigId = raw.subarray(TD_REPORT_OFFSET + 184, TD_REPORT_OFFSET + 232).toString('hex');
    const mrOwner = raw.subarray(TD_REPORT_OFFSET + 232, TD_REPORT_OFFSET + 280).toString('hex');
    const mrOwnerConfig = raw.subarray(TD_REPORT_OFFSET + 280, TD_REPORT_OFFSET + 328).toString('hex');
    const rtMr0 = raw.subarray(TD_REPORT_OFFSET + 328, TD_REPORT_OFFSET + 376).toString('hex');
    const rtMr1 = raw.subarray(TD_REPORT_OFFSET + 376, TD_REPORT_OFFSET + 424).toString('hex');
    const rtMr2 = raw.subarray(TD_REPORT_OFFSET + 424, TD_REPORT_OFFSET + 472).toString('hex');
    const rtMr3 = raw.subarray(TD_REPORT_OFFSET + 472, TD_REPORT_OFFSET + 520).toString('hex');
    const reportData = raw.subarray(TD_REPORT_OFFSET + 520, TD_REPORT_OFFSET + 584).toString('hex');

    return {
        version,
        attestKeyType,
        teeTcbSvn,
        mrSeam,
        mrSignerSeam,
        seamAttributes,
        tdAttributes,
        xfam,
        mrTd,
        mrConfigId,
        mrOwner,
        mrOwnerConfig,
        rtMr0,
        rtMr1,
        rtMr2,
        rtMr3,
        reportData,
    };
}

/**
 * Verify that report_data binds a BSV public key:
 * First 32 bytes = SHA256(compressed_pubkey_hex), last 32 bytes = zeros.
 */
export function verifyReportDataBinding(reportDataHex: string, teePublicKeyHex: string): boolean {
    const crypto = require('crypto');
    const expectedHash = crypto
        .createHash('sha256')
        .update(Buffer.from(teePublicKeyHex, 'hex'))
        .digest('hex');

    const first32 = reportDataHex.substring(0, 64);
    const last32 = reportDataHex.substring(64, 128);
    const zerosExpected = '0'.repeat(64);

    return first32 === expectedHash && last32 === zerosExpected;
}
