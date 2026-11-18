import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { lstatSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { machineNative } from './machine-registration.js';

export function readMachineSecret(dataRoot: string): Buffer {
  const path = resolve(dataRoot, 'native-secret');
  machineNative().verifyPrivate(dataRoot);
  machineNative().verifyPrivate(path);
  if (process.platform !== 'win32') {
    for (const target of [dataRoot, path]) {
      const stat = lstatSync(target);
      if (stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0 || stat.isSymbolicLink()) throw new Error('Machine secret permissions are unsafe.');
    }
  }
  const file = lstatSync(path);
  if (!file.isFile() || file.nlink !== 1 || file.size !== 65) throw new Error('Invalid machine secret file.');
  const text = readFileSync(path, 'utf8');
  if (!/^[a-f0-9]{64}\n$/u.test(text)) throw new Error('Invalid machine secret.');
  return Buffer.from(text.slice(0, 64), 'hex');
}

export function machineProof(secret: Buffer, purpose: 'health' | 'relay', instanceRef: string, challenge: string): string {
  return createHmac('sha256', secret).update(`${purpose}:${instanceRef}:${challenge}`).digest('hex');
}

export function newRelayProof(secret: Buffer, instanceRef: string): string {
  const timestamp = String(Date.now());
  const nonce = randomBytes(16).toString('hex');
  const challenge = `${timestamp}:${nonce}`;
  return `${timestamp}.${nonce}.${machineProof(secret, 'relay', instanceRef, challenge)}`;
}

export function sameProof(expected: string, actual: string): boolean {
  if (!/^[a-f0-9]{64}$/u.test(actual)) return false;
  return timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(actual, 'hex'));
}

export async function verifyBrokerHealth(url: URL, instanceRef: string, secret: Buffer): Promise<void> {
  const challenge = randomBytes(32).toString('hex');
  const endpoint = new URL('/health', url);
  endpoint.searchParams.set('challenge', challenge);
  const response = await fetch(endpoint, { redirect: 'error', signal: AbortSignal.timeout(5_000) });
  const health = await response.json() as { instanceRef?: string; proof?: string };
  if (!response.ok || health.instanceRef !== instanceRef || typeof health.proof !== 'string' ||
      !sameProof(machineProof(secret, 'health', instanceRef, challenge), health.proof)) throw new Error('The Broker failed machine authentication.');
}

function credentialAad(instanceRef: string, method: string, path: string, time: string, body: Buffer): Buffer {
  return Buffer.from(`tabro-auth-v1:${instanceRef}:${method}:${path}:${time}:${createHash('sha256').update(body).digest('hex')}`);
}

export function sealCredential(secret: Buffer, token: string, instanceRef: string, method: string, path: string, body: Buffer): string {
  const time = String(Date.now());
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', secret, iv);
  cipher.setAAD(credentialAad(instanceRef, method, path, time, body));
  const ciphertext = Buffer.concat([cipher.update(token, 'utf8'), cipher.final()]);
  return [time, iv.toString('hex'), ciphertext.toString('hex'), cipher.getAuthTag().toString('hex')].join('.');
}

export function openCredential(secret: Buffer, value: string, instanceRef: string, method: string, path: string, body: Buffer): { token: string; nonce: string; expires: number } | null {
  const match = /^(\d{13})\.([a-f0-9]{24})\.([a-f0-9]{32,8192})\.([a-f0-9]{32})$/u.exec(value);
  const now = Date.now();
  if (!match || match[3]!.length % 2 !== 0 || Math.abs(now - Number(match[1])) > 30_000) return null;
  try {
    const decipher = createDecipheriv('aes-256-gcm', secret, Buffer.from(match[2]!, 'hex'));
    decipher.setAAD(credentialAad(instanceRef, method, path, match[1]!, body));
    decipher.setAuthTag(Buffer.from(match[4]!, 'hex'));
    return { token: Buffer.concat([decipher.update(Buffer.from(match[3]!, 'hex')), decipher.final()]).toString('utf8'), nonce: match[2]!, expires: now + 60_000 };
  } catch { return null; }
}
