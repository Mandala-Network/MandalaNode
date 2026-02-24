/**
 * Cross-language PushDrop compatibility test.
 *
 * Uses the SAME test vectors as the Python companion test
 * (private-ml-sdk/vllm-proxy/tests/test_pushdrop.py).
 *
 * Both tests must produce byte-identical locking script hex.
 *
 * Run with: npx jest pushdrop-compat.test.ts  (or npx tsx --test)
 */

import { LockingScript, PushDrop, Utils } from '@bsv/sdk'
import type { WalletInterface } from '@bsv/sdk'

// ---------------------------------------------------------------------------
// Shared test vectors (MUST match the Python test exactly)
// ---------------------------------------------------------------------------
const DERIVED_PUBKEY_HEX = '02' + 'aa'.repeat(32) // 33-byte compressed pubkey
const FIELDS: number[][] = [
  Array.from(Buffer.from('field-zero', 'utf8')),
  Array.from(Buffer.from('field-one', 'utf8')),
  Array.from(Buffer.from('field-two', 'utf8'))
]
const DATA_SIG: number[] = new Array(71).fill(0xbb) // fake 71-byte DER signature

/**
 * Expected locking script hex, computed independently and verified against
 * the Python implementation.
 *
 * Layout:
 *   21 <33-byte pubkey> AC          -- lock prefix (PUSH33 <pubkey> OP_CHECKSIG)
 *   0A <"field-zero">               -- push 10 bytes
 *   09 <"field-one">                -- push 9 bytes
 *   09 <"field-two">                -- push 9 bytes
 *   47 <71 bytes of 0xBB>           -- push 71-byte sig
 *   6D 6D                           -- 2x OP_2DROP (4 items / 2)
 */
const EXPECTED_HEX =
  '2102aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaac' +
  '0a6669656c642d7a65726f' +
  '096669656c642d6f6e65' +
  '096669656c642d74776f' +
  '47bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' +
  '6d6d'

// ---------------------------------------------------------------------------
// Mock wallet that returns deterministic pubkey and signature
// ---------------------------------------------------------------------------
function createMockWallet (): WalletInterface {
  return {
    getPublicKey: async () => ({ publicKey: DERIVED_PUBKEY_HEX }),
    createSignature: async () => ({ signature: DATA_SIG }),
    // Stub remaining WalletInterface methods (unused by PushDrop.lock)
    isAuthenticated: async () => ({ authenticated: true }),
    getHeight: async () => ({ height: 0 }),
    getNetwork: async () => ({ network: 'mainnet' as const }),
    getVersion: async () => ({ version: '1.0.0' }),
    getHeaderForHeight: async () => ({ header: '' }),
    createAction: async () => ({} as any),
    signAction: async () => ({} as any),
    abortAction: async () => ({} as any),
    listActions: async () => ({} as any),
    internalizeAction: async () => ({} as any),
    listOutputs: async () => ({} as any),
    relinquishOutput: async () => ({} as any),
    acquireCertificate: async () => ({} as any),
    listCertificates: async () => ({} as any),
    proveCertificate: async () => ({} as any),
    relinquishCertificate: async () => ({} as any),
    discoverByIdentityKey: async () => ({} as any),
    discoverByAttributes: async () => ({} as any),
    verifySignature: async () => ({} as any),
    revealCounterpartyKeyLinkage: async () => ({} as any),
    revealSpecificKeyLinkage: async () => ({} as any),
    encrypt: async () => ({} as any),
    decrypt: async () => ({} as any),
    createHmac: async () => ({} as any),
    verifyHmac: async () => ({} as any)
  } as unknown as WalletInterface
}

// ---------------------------------------------------------------------------
// Minimal-push encoding helper (mirrors Python _minimal_push)
// ---------------------------------------------------------------------------
function minimalPush (data: number[]): number[] {
  const n = data.length
  if (n === 0 || (n === 1 && data[0] === 0)) {
    return [0x00]
  }
  if (n === 1 && data[0] >= 1 && data[0] <= 16) {
    return [0x50 + data[0]]
  }
  if (n === 1 && data[0] === 0x81) {
    return [0x4f]
  }
  if (n <= 75) {
    return [n, ...data]
  }
  if (n <= 255) {
    return [0x4c, n, ...data]
  }
  if (n <= 65535) {
    return [0x4d, n & 0xff, (n >> 8) & 0xff, ...data]
  }
  return [0x4e, n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >> 24) & 0xff, ...data]
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe('PushDrop cross-language compatibility', () => {
  // -----------------------------------------------------------------------
  // A) Build locking script via @bsv/sdk PushDrop.lock and compare
  // -----------------------------------------------------------------------
  test('PushDrop.lock() produces the expected hex (SDK path)', async () => {
    const wallet = createMockWallet()
    const pd = new PushDrop(wallet)

    // PushDrop.lock mutates the fields array (appends signature), so clone
    const fieldsCopy = FIELDS.map(f => [...f])

    const lockingScript = await pd.lock(
      fieldsCopy,
      [2, 'test protocol'],
      'test-key',
      'anyone',
      false, // forSelf
      true, // includeSignature
      'before' // lockPosition
    )

    const hex = lockingScript.toHex()
    expect(hex).toBe(EXPECTED_HEX)
  })

  // -----------------------------------------------------------------------
  // B) Manually construct the same script (no SDK dependency) and compare
  // -----------------------------------------------------------------------
  test('manual script construction matches expected hex', () => {
    const script: number[] = []

    // Lock prefix: PUSH(33) <pubkey> OP_CHECKSIG
    const pubkeyBytes = Utils.toArray(DERIVED_PUBKEY_HEX, 'hex')
    script.push(0x21)
    script.push(...pubkeyBytes)
    script.push(0xac) // OP_CHECKSIG

    // Push each field
    for (const field of FIELDS) {
      script.push(...minimalPush(field))
    }

    // Push the data signature
    script.push(...minimalPush(DATA_SIG))

    // Drop sequence: 4 items (3 fields + 1 sig) -> 2x OP_2DROP
    script.push(0x6d) // OP_2DROP
    script.push(0x6d) // OP_2DROP

    const hex = Utils.toHex(script)
    expect(hex).toBe(EXPECTED_HEX)
  })

  // -----------------------------------------------------------------------
  // C) Verify the expected hex length is correct
  // -----------------------------------------------------------------------
  test('expected hex has correct byte length', () => {
    const bytes = EXPECTED_HEX.length / 2
    // 1 (push33 op) + 33 (pubkey) + 1 (OP_CHECKSIG)
    // + 1+10 (field-zero) + 1+9 (field-one) + 1+9 (field-two)
    // + 1+71 (data sig)
    // + 2 (2x OP_2DROP)
    const expected = 1 + 33 + 1 + (1 + 10) + (1 + 9) + (1 + 9) + (1 + 71) + 2
    expect(bytes).toBe(expected) // 140
  })

  // -----------------------------------------------------------------------
  // D) Verify drop sequence for various item counts
  // -----------------------------------------------------------------------
  test.each([
    { nFields: 1, expected2Drop: 1, expectedDrop: 0 }, // 2 items
    { nFields: 2, expected2Drop: 1, expectedDrop: 1 }, // 3 items
    { nFields: 3, expected2Drop: 2, expectedDrop: 0 }, // 4 items
    { nFields: 8, expected2Drop: 4, expectedDrop: 1 }, // 9 items
    { nFields: 9, expected2Drop: 5, expectedDrop: 0 } // 10 items
  ])('drop sequence for $nFields fields', async ({ nFields, expected2Drop, expectedDrop }) => {
    const wallet = createMockWallet()
    const pd = new PushDrop(wallet)
    const fields = Array.from({ length: nFields }, () => Array.from(Buffer.from('test-data!')))

    const lockingScript = await pd.lock(
      fields,
      [2, 'test protocol'],
      'test-key',
      'anyone',
      false,
      true,
      'before'
    )

    const hex = lockingScript.toHex()
    const scriptBytes = Utils.toArray(hex, 'hex')

    // Count trailing OP_2DROP (0x6d) and OP_DROP (0x75) from the end
    let actual2Drop = 0
    let actualDrop = 0
    let i = scriptBytes.length - 1
    while (i >= 0) {
      if (scriptBytes[i] === 0x6d) {
        actual2Drop++
        i--
      } else if (scriptBytes[i] === 0x75) {
        actualDrop++
        i--
      } else {
        break
      }
    }

    expect(actual2Drop).toBe(expected2Drop)
    expect(actualDrop).toBe(expectedDrop)
  })

  // -----------------------------------------------------------------------
  // E) Minimal-push edge cases (mirrors Python TestMinimalPush)
  // -----------------------------------------------------------------------
  describe('minimalPush encoding', () => {
    test('empty data -> OP_0', () => {
      expect(minimalPush([])).toEqual([0x00])
    })

    test('single zero byte -> OP_0', () => {
      expect(minimalPush([0x00])).toEqual([0x00])
    })

    test('single bytes 1-16 -> OP_1 through OP_16', () => {
      for (let v = 1; v <= 16; v++) {
        expect(minimalPush([v])).toEqual([0x50 + v])
      }
    })

    test('0x81 -> OP_1NEGATE', () => {
      expect(minimalPush([0x81])).toEqual([0x4f])
    })

    test('single byte 0x11 (17) -> direct push', () => {
      expect(minimalPush([0x11])).toEqual([0x01, 0x11])
    })

    test('75 bytes -> direct push', () => {
      const data = Array.from({ length: 75 }, (_, i) => i)
      const result = minimalPush(data)
      expect(result[0]).toBe(75)
      expect(result.slice(1)).toEqual(data)
    })

    test('76 bytes -> OP_PUSHDATA1', () => {
      const data = new Array(76).fill(0xab)
      const result = minimalPush(data)
      expect(result[0]).toBe(0x4c)
      expect(result[1]).toBe(76)
      expect(result.slice(2)).toEqual(data)
    })

    test('256 bytes -> OP_PUSHDATA2', () => {
      const data = new Array(256).fill(0xef)
      const result = minimalPush(data)
      expect(result[0]).toBe(0x4d)
      expect(result[1]).toBe(0x00) // 256 & 0xff
      expect(result[2]).toBe(0x01) // 256 >> 8
      expect(result.slice(3)).toEqual(data)
    })
  })
})
