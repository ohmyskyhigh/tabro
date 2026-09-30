export interface DeviceIdentity {
  publicKeyJwk: JsonWebKey;
  privateKeyJwk: JsonWebKey;
  pairingCode: string | null;
  proposedNickname: string;
  endpointId?: string;
  nickname?: string;
}

const PAIRING_ADJECTIVES = [
  'AMBER', 'BRAVE', 'BRIGHT', 'CALM', 'CLEAR', 'CLOUD', 'COOL', 'CORAL',
  'CRISP', 'DEEP', 'EAGER', 'FAIR', 'FRESH', 'GOLD', 'GREEN', 'HAPPY',
  'LIGHT', 'LUCKY', 'MELLOW', 'MINT', 'NEAT', 'NOVA', 'PEARL', 'QUICK',
  'QUIET', 'RED', 'SILVER', 'SUNNY', 'SWIFT', 'VIOLET', 'WARM', 'WISE',
  'BLUE', 'BOLD', 'COSMIC', 'DUSK', 'EARLY', 'GENTLE', 'GLOW', 'IVORY',
  'JADE', 'KIND', 'LUNAR', 'MAPLE', 'MERRY', 'MISTY', 'OCEAN', 'ORANGE',
  'PINK', 'PROUD', 'RAPID', 'ROYAL', 'SAGE', 'SOFT', 'SOLAR', 'SPRY',
  'TEAL', 'TIDY', 'TRUE', 'URBAN', 'WHITE', 'WILD', 'YOUNG', 'ZESTY'
] as const;

const PAIRING_NOUNS = [
  'BAY', 'BIRD', 'BLOOM', 'BROOK', 'CEDAR', 'COMET', 'DUNE', 'ECHO',
  'FIELD', 'FLAME', 'FOREST', 'FOX', 'GARDEN', 'GROVE', 'HARBOR', 'HILL',
  'LAKE', 'LEAF', 'MOON', 'OTTER', 'PINE', 'REEF', 'RIVER', 'SKY',
  'STAR', 'STONE', 'SUN', 'WAVE', 'WILLOW', 'WIND', 'WOLF', 'WOOD',
  'ASH', 'BEAR', 'BREEZE', 'CANYON', 'CLOUD', 'DAWN', 'DEER', 'DOVE',
  'DREAM', 'FALCON', 'FERN', 'FROST', 'GLEN', 'HAWK', 'ISLAND', 'JAY',
  'LION', 'MEADOW', 'OAK', 'ORBIT', 'OWL', 'PEAK', 'POND', 'RAIN',
  'ROBIN', 'SEAL', 'SHORE', 'SPARK', 'TIGER', 'TRAIL', 'VALE', 'WHALE'
] as const;

const PAIRING_CODE_PATTERN = /^[A-Z]{3,8}-[A-Z]{3,8}$/;
const PAIRING_CODE_ERROR = 'Pairing code must contain two 3-8 letter words separated by one hyphen.';

export async function loadOrCreateIdentity(): Promise<DeviceIdentity> {
  const stored = await chrome.storage.local.get([
    'publicKeyJwk',
    'privateKeyJwk',
    'endpointId',
    'endpointNickname',
    'proposedNickname',
    'profilePairingCode',
    'targetId',
    'targetAlias'
  ]);
  if (stored.publicKeyJwk && stored.privateKeyJwk) {
    const publicKeyJwk = stored.publicKeyJwk as JsonWebKey;
    const endpointId = typeof stored.endpointId === 'string'
      ? stored.endpointId
      : typeof stored.targetId === 'string' ? stored.targetId : undefined;
    const storedPairingCode = typeof stored.profilePairingCode === 'string'
      ? normalizePairingCode(stored.profilePairingCode)
      : null;
    const pairingCode = storedPairingCode && PAIRING_CODE_PATTERN.test(storedPairingCode)
      ? storedPairingCode
      : endpointId ? null : createRandomPairingCode();
    const proposedNickname = pairingCode
      ? createNicknameFromPairingCode(pairingCode)
      : typeof stored.endpointNickname === 'string'
        ? stored.endpointNickname
        : typeof stored.targetAlias === 'string'
          ? stored.targetAlias
          : typeof stored.proposedNickname === 'string' ? stored.proposedNickname : 'octopus';
    if (stored.proposedNickname !== proposedNickname || stored.profilePairingCode !== pairingCode) {
      await chrome.storage.local.set({ proposedNickname, profilePairingCode: pairingCode });
    }
    return {
      publicKeyJwk,
      privateKeyJwk: stored.privateKeyJwk as JsonWebKey,
      pairingCode,
      proposedNickname,
      ...(endpointId ? { endpointId } : {}),
      ...(typeof stored.endpointNickname === 'string'
        ? { nickname: stored.endpointNickname }
        : typeof stored.targetAlias === 'string' ? { nickname: stored.targetAlias } : {})
    };
  }
  const keys = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const publicKeyJwk = await crypto.subtle.exportKey('jwk', keys.publicKey);
  const privateKeyJwk = await crypto.subtle.exportKey('jwk', keys.privateKey);
  const pairingCode = createRandomPairingCode();
  const proposedNickname = createNicknameFromPairingCode(pairingCode);
  await chrome.storage.local.set({ publicKeyJwk, privateKeyJwk, pairingCode: null, profilePairingCode: pairingCode, proposedNickname });
  return { publicKeyJwk, privateKeyJwk, pairingCode, proposedNickname };
}

export async function savePairing(endpointId: string, nickname: string): Promise<void> {
  await chrome.storage.local.set({
    endpointId,
    endpointNickname: nickname,
    // Keep the previous keys during in-place migration so an older broker can still reconnect.
    targetId: endpointId,
    targetAlias: nickname
  });
  await chrome.storage.local.remove('pairingCode');
}

export async function resetIdentity(): Promise<void> {
  await chrome.storage.local.remove([
    'publicKeyJwk',
    'privateKeyJwk',
    'proposedNickname',
    'profilePairingCode',
    'endpointId',
    'endpointNickname',
    'targetId',
    'targetAlias',
    'pairingCode',
    'recentAttemptOutcomesV2'
  ]);
}

export function createRandomPairingCode(previous: string | null = null): string {
  for (;;) {
    const entropy = crypto.getRandomValues(new Uint16Array(2));
    const adjective = PAIRING_ADJECTIVES[(entropy[0] ?? 0) % PAIRING_ADJECTIVES.length]!;
    const noun = PAIRING_NOUNS[(entropy[1] ?? 0) % PAIRING_NOUNS.length]!;
    const code = `${adjective}-${noun}`;
    if (code !== previous) return code;
  }
}

export function createNicknameFromPairingCode(pairingCode: string): string {
  return pairingCode.replace('-', '').toLowerCase();
}

export function normalizePairingCode(value: string): string {
  return value.trim().toUpperCase().replace(/[\s_]+/g, '-');
}

export function validatePairingCode(value: string): string {
  const normalized = normalizePairingCode(value);
  if (!PAIRING_CODE_PATTERN.test(normalized)) throw new Error(PAIRING_CODE_ERROR);
  return normalized;
}

export async function saveCustomPairingCode(value: string): Promise<{
  pairingCode: string;
  proposedNickname: string;
}> {
  const pairingCode = validatePairingCode(value);
  const proposedNickname = createNicknameFromPairingCode(pairingCode);
  await chrome.storage.local.set({ profilePairingCode: pairingCode, proposedNickname });
  return { pairingCode, proposedNickname };
}

export async function regeneratePairingLabel(): Promise<{ pairingCode: string; proposedNickname: string }> {
  const stored = await chrome.storage.local.get(['endpointId', 'targetId', 'profilePairingCode']);
  if (typeof stored.endpointId === 'string' || typeof stored.targetId === 'string') {
    throw new Error('A paired endpoint cannot regenerate its nickname during reconnect.');
  }
  const previous = typeof stored.profilePairingCode === 'string' ? stored.profilePairingCode : null;
  const pairingCode = createRandomPairingCode(previous);
  const proposedNickname = createNicknameFromPairingCode(pairingCode);
  await chrome.storage.local.set({ profilePairingCode: pairingCode, proposedNickname });
  return { pairingCode, proposedNickname };
}

export async function signChallenge(privateKeyJwk: JsonWebKey, nonce: string): Promise<string> {
  const key = await crypto.subtle.importKey('jwk', privateKeyJwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const signature = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, new TextEncoder().encode(nonce));
  const bytes = new Uint8Array(signature);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}
