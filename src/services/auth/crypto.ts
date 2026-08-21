import { scryptAsync } from '@noble/hashes/scrypt.js'

const encoder = new TextEncoder()

const SCRYPT_VERSION = 1
const SCRYPT_N = 16_384
const SCRYPT_R = 16
const SCRYPT_P = 1
const SCRYPT_KEY_LENGTH = 64
const SCRYPT_MAX_MEMORY = 128 * SCRYPT_N * SCRYPT_R * 2

// Cloudflare Workers expose Web Crypto and browser-compatible base64 helpers.
// URL-safe encoding keeps random tokens valid in cookies and GraphQL strings.
const toBase64Url = (bytes: Uint8Array): string => {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '')
}

const fromBase64Url = (value: string): Uint8Array => {
  const padded = value.replaceAll('-', '+').replaceAll('_', '/').padEnd(
    value.length + ((4 - (value.length % 4)) % 4),
    '=',
  )
  const binary = atob(padded)
  return Uint8Array.from(binary, (character) => character.charCodeAt(0))
}

const derivePasswordKey = (
  password: Uint8Array,
  salt: Uint8Array,
): Promise<Uint8Array> => {
  return scryptAsync(password, salt, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
    dkLen: SCRYPT_KEY_LENGTH,
    maxmem: SCRYPT_MAX_MEMORY,
    asyncTick: 10,
  })
}

const equalBytes = (left: Uint8Array, right: Uint8Array): boolean => {
  // Compare every byte so password verification does not leak a matching prefix.
  if (left.length !== right.length) return false
  let difference = 0
  for (let index = 0; index < left.length; index += 1) {
    difference |= left[index] ^ right[index]
  }
  return difference === 0
}

export const createChallengeToken = (): string => {
  // 32 random bytes provide a full 256 bits of challenge entropy.
  return toBase64Url(crypto.getRandomValues(new Uint8Array(32)))
}

export const createOtp = (): string => {
  const range = 1_000_000
  const maximum = Math.floor(0x1_0000_0000 / range) * range
  const random = new Uint32Array(1)

  // Rejection sampling avoids modulo bias across the six-digit range.
  do crypto.getRandomValues(random)
  while (random[0] >= maximum)

  return String(random[0] % range).padStart(6, '0')
}

export const createDigest = async (
  secret: string,
  purpose: string,
  value: string,
): Promise<string> => {
  // Purpose separation prevents a digest from one credential type being
  // accepted as another even when their plaintext values happen to match.
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const digest = await crypto.subtle.sign('HMAC', key, encoder.encode(`${purpose}:${value}`))
  return toBase64Url(new Uint8Array(digest))
}

export const hashPassword = async (password: string): Promise<string> => {
  const salt = crypto.getRandomValues(new Uint8Array(16))
  // Encoding the supplied string directly preserves the password byte-for-byte;
  // authentication never trims or Unicode-normalizes new passwords.
  const key = await derivePasswordKey(encoder.encode(password), salt)
  return [
    'scrypt',
    SCRYPT_VERSION,
    SCRYPT_N,
    SCRYPT_R,
    SCRYPT_P,
    toBase64Url(salt),
    toBase64Url(key),
  ].join('$')
}

export const verifyPassword = async (encodedHash: string, password: string): Promise<boolean> => {
  // Parameters are encoded with every password so future formats can be versioned
  // without silently verifying a hash using weaker settings.
  const [algorithm, version, n, r, p, encodedSalt, encodedKey] = encodedHash.split('$')
  if (
    algorithm !== 'scrypt' ||
    Number(version) !== SCRYPT_VERSION ||
    Number(n) !== SCRYPT_N ||
    Number(r) !== SCRYPT_R ||
    Number(p) !== SCRYPT_P ||
    !encodedSalt ||
    !encodedKey
  ) {
    throw new Error('Unsupported password hash format.')
  }

  const expected = fromBase64Url(encodedKey)
  const actual = await derivePasswordKey(encoder.encode(password), fromBase64Url(encodedSalt))
  return equalBytes(actual, expected)
}

// Unknown emails still perform the same expensive scrypt operation. The zero
// key is deliberately invalid; it exists only to reduce account-timing leaks.
export const DUMMY_PASSWORD_HASH = [
  'scrypt',
  SCRYPT_VERSION,
  SCRYPT_N,
  SCRYPT_R,
  SCRYPT_P,
  toBase64Url(new Uint8Array(16)),
  toBase64Url(new Uint8Array(SCRYPT_KEY_LENGTH)),
].join('$')
