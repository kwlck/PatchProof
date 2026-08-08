import { createHmac, timingSafeEqual } from 'node:crypto';

export function verifyWebhookSignature(
  payload: string | Uint8Array,
  signatureHeader: string | undefined,
  secret: string,
): boolean {
  if (signatureHeader === undefined || !signatureHeader.startsWith('sha256=')) return false;
  const suppliedHex = signatureHeader.slice('sha256='.length);
  if (!/^[0-9a-f]{64}$/i.test(suppliedHex)) return false;
  const expected = createHmac('sha256', secret).update(payload).digest();
  const supplied = Buffer.from(suppliedHex, 'hex');
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

export function computeWebhookSignature(payload: string | Uint8Array, secret: string): string {
  return `sha256=${createHmac('sha256', secret).update(payload).digest('hex')}`;
}
