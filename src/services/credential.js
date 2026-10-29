import { createHash, randomBytes } from 'node:crypto';

const TOKEN_PREFIX = 'ER1.';
const FALLBACK_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';

export function credentialHash(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function fallbackCode(bytes = randomBytes(8)) {
  let code = '';
  for (let index = 0; index < 8; index += 1) {
    code += FALLBACK_ALPHABET[bytes[index] % FALLBACK_ALPHABET.length];
  }
  return `${code.slice(0, 4)}-${code.slice(4)}`;
}

export function normaliseFallbackCode(value) {
  return String(value).trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
}

export function createCredential({ tokenBytes = randomBytes(24), fallbackBytes = randomBytes(8) } = {}) {
  const token = `${TOKEN_PREFIX}${Buffer.from(tokenBytes).toString('base64url')}`;
  const fallback = fallbackCode(Buffer.from(fallbackBytes));
  return {
    token,
    tokenHash: credentialHash(token),
    fallback,
    fallbackHash: credentialHash(normaliseFallbackCode(fallback)),
  };
}

export function scannedCredentialHash(value) {
  const input = String(value).trim();
  return credentialHash(input.toUpperCase().startsWith(TOKEN_PREFIX) ? input : normaliseFallbackCode(input));
}

