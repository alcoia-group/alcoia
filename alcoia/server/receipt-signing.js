/* receipt-signing.js — issue and check receipt signatures
 *
 * WHAT THIS PROVES, EXACTLY
 * A valid signature proves the receipt is byte-for-byte what this server
 * issued. It proves nothing about whether the reading happened. The numbers
 * come from the reader's own browser, and a modified extension could send
 * anything it likes. This is tamper-evidence for the artifact, not
 * verification of the behaviour it describes.
 *
 * That distinction is the whole reason this file exists rather than a
 * hand-rolled hash: anyone reading the code should hit the limitation before
 * they hit the crypto. Wording shown to a lecturer must say "unaltered since
 * issued", never "verified" or "authentic". Anything stronger would require
 * the measurement to happen somewhere the reader does not control, which is
 * exactly the covert monitoring this product refuses to build.
 *
 * HMAC-SHA256 with a server secret. Verification therefore goes back through
 * the server, which is fine for a lecturer checking a submission and keeps the
 * key from ever leaving the machine. Asymmetric signing would let third
 * parties verify offline; it is not obviously worth the key management here
 * and is a decision for a human, not a default to slip in.
 */

'use strict';

const crypto = require('crypto');

/* Byte-stable serialisation. A receipt that round-trips through JSON.parse
 * must produce the same string, or nothing will ever verify. Object keys are
 * sorted; undefined becomes null. */
function canonicalise(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalise).join(',')}]`;
  if (value && typeof value === 'object') {
    const keys = Object.keys(value).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalise(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value === undefined ? null : value);
}

/* The signature covers the receipt with any existing signature block removed,
 * so signing is idempotent and a receipt cannot be made to sign over its own
 * signature. */
function payloadFor(receipt) {
  const { signature, ...rest } = receipt || {};
  return canonicalise(rest);
}

function sign(receipt, secret) {
  if (!secret) throw new Error('No signing secret configured');
  const payload = payloadFor(receipt);
  const mac = crypto.createHmac('sha256', secret).update(payload).digest('base64url');
  return {
    ...receipt,
    signature: {
      alg: 'HMAC-SHA256',
      value: mac,
      issuedAt: new Date().toISOString(),
      note: 'Proves this receipt is unchanged since it was issued. Does not verify that the reading occurred as described.',
    },
  };
}

function verify(receipt, secret) {
  if (!secret) return { valid: false, reason: 'no_secret_configured' };
  const sig = receipt && receipt.signature;
  if (!sig || typeof sig.value !== 'string') return { valid: false, reason: 'unsigned' };
  if (sig.alg !== 'HMAC-SHA256') return { valid: false, reason: 'unsupported_algorithm' };

  const expected = crypto.createHmac('sha256', secret).update(payloadFor(receipt)).digest('base64url');
  const a = Buffer.from(expected);
  const b = Buffer.from(sig.value);
  // Length check first: timingSafeEqual throws on a length mismatch.
  const valid = a.length === b.length && crypto.timingSafeEqual(a, b);

  return valid
    ? { valid: true, issuedAt: sig.issuedAt || null }
    : { valid: false, reason: 'altered_since_issue' };
}

module.exports = { canonicalise, payloadFor, sign, verify };
