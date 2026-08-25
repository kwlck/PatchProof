import {
  createHash,
  createPublicKey,
  createSign,
  createVerify,
  generateKeyPairSync,
} from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';

export interface EvidenceSignature {
  version: 1;
  algorithm: 'rsa-sha256';
  keyFingerprint: string;
  signature: string;
}

export interface SignatureVerification {
  valid: boolean;
  errors: string[];
}

export function generateSigningKeyPair(): { privateKey: string; publicKey: string } {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  return {
    privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    publicKey: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
  };
}

/** SHA-256 fingerprint over the canonical SPKI DER, identical for both key forms. */
export function publicKeyFingerprint(keyPem: string): string {
  const spki = createPublicKey(keyPem).export({ type: 'spki', format: 'der' });
  return createHash('sha256').update(spki).digest('hex');
}

/**
 * Signs the exact bytes of an evidence bundle. The bundle's own integrity
 * hash stays untouched; the envelope proves who published these bytes.
 */
export async function signEvidenceFile(
  bundlePath: string,
  privateKeyPem: string,
  signaturePath?: string,
): Promise<EvidenceSignature> {
  const bytes = await readFile(bundlePath);
  const signer = createSign('RSA-SHA256');
  signer.update(bytes);
  const signature = signer.sign(privateKeyPem).toString('base64url');
  const keyFingerprint = publicKeyFingerprint(privateKeyPem);
  const envelope: EvidenceSignature = {
    version: 1,
    algorithm: 'rsa-sha256',
    keyFingerprint,
    signature,
  };
  const destination = signaturePath ?? `${bundlePath}.sig`;
  await writeFile(destination, `${JSON.stringify(envelope, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });
  return envelope;
}

export async function verifyEvidenceSignature(
  bundlePath: string,
  signaturePath: string,
  publicKeyPem: string,
): Promise<SignatureVerification> {
  const errors: string[] = [];
  let envelope: EvidenceSignature;
  try {
    const raw = await readFile(signaturePath, 'utf8');
    const parsed = JSON.parse(raw) as Partial<EvidenceSignature>;
    if (
      parsed?.version !== 1 ||
      parsed.algorithm !== 'rsa-sha256' ||
      typeof parsed.keyFingerprint !== 'string' ||
      typeof parsed.signature !== 'string'
    ) {
      return { valid: false, errors: ['Signature envelope shape or algorithm is unsupported'] };
    }
    envelope = parsed as EvidenceSignature;
  } catch (error) {
    return {
      valid: false,
      errors: [
        `Signature envelope is unreadable: ${error instanceof Error ? error.message : String(error)}`,
      ],
    };
  }
  const expectedFingerprint = publicKeyFingerprint(publicKeyPem);
  if (envelope.keyFingerprint !== expectedFingerprint) {
    errors.push('Signature key fingerprint does not match the provided public key');
  }
  const bytes = await readFile(bundlePath);
  const verifier = createVerify('RSA-SHA256');
  verifier.update(bytes);
  const valid = verifier.verify(publicKeyPem, Buffer.from(envelope.signature, 'base64url'));
  if (!valid) errors.push('Signature does not match the bundle bytes');
  return { valid: errors.length === 0 && valid, errors };
}
