import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'

import { serverEnv } from './env'

export const AI_COOKIE = 'bucket_ai'

interface StoredKey {
  apiKey: string
  model: string
}

function key(): Buffer {
  return createHash('sha256').update(serverEnv.cookieSecret()).digest()
}

export function sealKey(value: StoredKey): string {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key(), iv)
  const body = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()])
  return Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64url')
}

function openKey(sealed: string): StoredKey | null {
  try {
    const raw = Buffer.from(sealed, 'base64url')
    const decipher = createDecipheriv('aes-256-gcm', key(), raw.subarray(0, 12))
    decipher.setAuthTag(raw.subarray(12, 28))
    const json = Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString('utf8')
    return JSON.parse(json) as StoredKey
  } catch {
    return null
  }
}

/**
 * The user's own OpenAI key (from the encrypted httpOnly cookie, never readable by page scripts), else the
 * server's. The sealed cookie value is passed in by the request handler — this module never reaches into
 * framework request state.
 */
export function resolveAiKey(sealed: string | undefined): { apiKey: string; model: string; source: 'byok' | 'server' } | null {
  const byok = sealed ? openKey(sealed) : null
  if (byok) return { ...byok, source: 'byok' }
  const server = serverEnv.openaiKey()
  return server ? { apiKey: server, model: serverEnv.openaiModel(), source: 'server' } : null
}
