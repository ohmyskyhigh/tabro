// apps/browser-extension/src/config.ts
var DEFAULT_URL = "ws://127.0.0.1:7332/relay";
async function loadSettings() {
  const stored = await chrome.storage.local.get(["brokerUrl", "transportMode"]);
  return {
    brokerUrl: typeof stored.brokerUrl === "string" ? stored.brokerUrl : DEFAULT_URL,
    transportMode: stored.transportMode === "websocket" ? "websocket" : "native"
  };
}
async function saveSettings(settings) {
  await chrome.storage.local.set({
    brokerUrl: settings.brokerUrl,
    transportMode: settings.transportMode
  });
  await chrome.storage.local.remove("pairingCode");
}

// apps/browser-extension/src/identity/device-identity.ts
var PAIRING_ADJECTIVES = [
  "AMBER",
  "BRAVE",
  "BRIGHT",
  "CALM",
  "CLEAR",
  "CLOUD",
  "COOL",
  "CORAL",
  "CRISP",
  "DEEP",
  "EAGER",
  "FAIR",
  "FRESH",
  "GOLD",
  "GREEN",
  "HAPPY",
  "LIGHT",
  "LUCKY",
  "MELLOW",
  "MINT",
  "NEAT",
  "NOVA",
  "PEARL",
  "QUICK",
  "QUIET",
  "RED",
  "SILVER",
  "SUNNY",
  "SWIFT",
  "VIOLET",
  "WARM",
  "WISE",
  "BLUE",
  "BOLD",
  "COSMIC",
  "DUSK",
  "EARLY",
  "GENTLE",
  "GLOW",
  "IVORY",
  "JADE",
  "KIND",
  "LUNAR",
  "MAPLE",
  "MERRY",
  "MISTY",
  "OCEAN",
  "ORANGE",
  "PINK",
  "PROUD",
  "RAPID",
  "ROYAL",
  "SAGE",
  "SOFT",
  "SOLAR",
  "SPRY",
  "TEAL",
  "TIDY",
  "TRUE",
  "URBAN",
  "WHITE",
  "WILD",
  "YOUNG",
  "ZESTY"
];
var PAIRING_NOUNS = [
  "BAY",
  "BIRD",
  "BLOOM",
  "BROOK",
  "CEDAR",
  "COMET",
  "DUNE",
  "ECHO",
  "FIELD",
  "FLAME",
  "FOREST",
  "FOX",
  "GARDEN",
  "GROVE",
  "HARBOR",
  "HILL",
  "LAKE",
  "LEAF",
  "MOON",
  "OTTER",
  "PINE",
  "REEF",
  "RIVER",
  "SKY",
  "STAR",
  "STONE",
  "SUN",
  "WAVE",
  "WILLOW",
  "WIND",
  "WOLF",
  "WOOD",
  "ASH",
  "BEAR",
  "BREEZE",
  "CANYON",
  "CLOUD",
  "DAWN",
  "DEER",
  "DOVE",
  "DREAM",
  "FALCON",
  "FERN",
  "FROST",
  "GLEN",
  "HAWK",
  "ISLAND",
  "JAY",
  "LION",
  "MEADOW",
  "OAK",
  "ORBIT",
  "OWL",
  "PEAK",
  "POND",
  "RAIN",
  "ROBIN",
  "SEAL",
  "SHORE",
  "SPARK",
  "TIGER",
  "TRAIL",
  "VALE",
  "WHALE"
];
var PAIRING_CODE_PATTERN = /^[A-Z]{3,8}-[A-Z]{3,8}$/;
var PAIRING_CODE_ERROR = "Pairing code must contain two 3-8 letter words separated by one hyphen.";
async function loadOrCreateIdentity() {
  const stored = await chrome.storage.local.get([
    "publicKeyJwk",
    "privateKeyJwk",
    "endpointId",
    "endpointNickname",
    "proposedNickname",
    "profilePairingCode",
    "targetId",
    "targetAlias"
  ]);
  if (stored.publicKeyJwk && stored.privateKeyJwk) {
    const publicKeyJwk2 = stored.publicKeyJwk;
    const endpointId = typeof stored.endpointId === "string" ? stored.endpointId : typeof stored.targetId === "string" ? stored.targetId : void 0;
    const storedPairingCode = typeof stored.profilePairingCode === "string" ? normalizePairingCode(stored.profilePairingCode) : null;
    const pairingCode3 = storedPairingCode && PAIRING_CODE_PATTERN.test(storedPairingCode) ? storedPairingCode : endpointId ? null : createRandomPairingCode();
    const proposedNickname2 = pairingCode3 ? createNicknameFromPairingCode(pairingCode3) : typeof stored.endpointNickname === "string" ? stored.endpointNickname : typeof stored.targetAlias === "string" ? stored.targetAlias : typeof stored.proposedNickname === "string" ? stored.proposedNickname : "octopus";
    if (stored.proposedNickname !== proposedNickname2 || stored.profilePairingCode !== pairingCode3) {
      await chrome.storage.local.set({ proposedNickname: proposedNickname2, profilePairingCode: pairingCode3 });
    }
    return {
      publicKeyJwk: publicKeyJwk2,
      privateKeyJwk: stored.privateKeyJwk,
      pairingCode: pairingCode3,
      proposedNickname: proposedNickname2,
      ...endpointId ? { endpointId } : {},
      ...typeof stored.endpointNickname === "string" ? { nickname: stored.endpointNickname } : typeof stored.targetAlias === "string" ? { nickname: stored.targetAlias } : {}
    };
  }
  const keys = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const publicKeyJwk = await crypto.subtle.exportKey("jwk", keys.publicKey);
  const privateKeyJwk = await crypto.subtle.exportKey("jwk", keys.privateKey);
  const pairingCode2 = createRandomPairingCode();
  const proposedNickname = createNicknameFromPairingCode(pairingCode2);
  await chrome.storage.local.set({ publicKeyJwk, privateKeyJwk, pairingCode: null, profilePairingCode: pairingCode2, proposedNickname });
  return { publicKeyJwk, privateKeyJwk, pairingCode: pairingCode2, proposedNickname };
}
async function resetIdentity() {
  await chrome.storage.local.remove([
    "publicKeyJwk",
    "privateKeyJwk",
    "proposedNickname",
    "profilePairingCode",
    "endpointId",
    "endpointNickname",
    "targetId",
    "targetAlias",
    "pairingCode",
    "recentAttemptOutcomesV2"
  ]);
}
function createRandomPairingCode(previous = null) {
  for (; ; ) {
    const entropy = crypto.getRandomValues(new Uint16Array(2));
    const adjective = PAIRING_ADJECTIVES[(entropy[0] ?? 0) % PAIRING_ADJECTIVES.length];
    const noun = PAIRING_NOUNS[(entropy[1] ?? 0) % PAIRING_NOUNS.length];
    const code = `${adjective}-${noun}`;
    if (code !== previous) return code;
  }
}
function createNicknameFromPairingCode(pairingCode2) {
  return pairingCode2.replace("-", "").toLowerCase();
}
function normalizePairingCode(value) {
  return value.trim().toUpperCase().replace(/[\s_]+/g, "-");
}
function validatePairingCode(value) {
  const normalized = normalizePairingCode(value);
  if (!PAIRING_CODE_PATTERN.test(normalized)) throw new Error(PAIRING_CODE_ERROR);
  return normalized;
}
async function saveCustomPairingCode(value) {
  const pairingCode2 = validatePairingCode(value);
  const proposedNickname = createNicknameFromPairingCode(pairingCode2);
  await chrome.storage.local.set({ profilePairingCode: pairingCode2, proposedNickname });
  return { pairingCode: pairingCode2, proposedNickname };
}

// apps/browser-extension/src/options.ts
var form = document.querySelector("#settings-form");
var brokerUrl = document.querySelector("#broker-url");
var transportMode = document.querySelector("#transport-mode");
var pairingCode = document.querySelector("#pairing-code");
var profileNickname = document.querySelector("#profile-nickname");
var status = document.querySelector("#status");
var reset = document.querySelector("#reset");
function statusText(value, alias, transport, lastError) {
  const state = typeof value === "string" ? value : "not connected";
  return `Status: ${state}${typeof alias === "string" ? ` \xB7 alias ${alias}` : ""}${typeof transport === "string" ? ` \xB7 ${transport}` : ""}${typeof lastError === "string" && lastError ? ` \xB7 ${lastError}` : ""}`;
}
async function refresh() {
  const [settings, identity] = await Promise.all([loadSettings(), loadOrCreateIdentity()]);
  const stored = await chrome.storage.local.get([
    "connectionStatus",
    "endpointNickname",
    "targetAlias",
    "transportKind",
    "lastError"
  ]);
  brokerUrl.value = settings.brokerUrl;
  transportMode.value = settings.transportMode;
  if (document.activeElement !== pairingCode) pairingCode.value = identity.pairingCode ?? "";
  profileNickname.textContent = identity.proposedNickname;
  const connectedNickname = stored.endpointNickname ?? stored.targetAlias ?? identity.nickname;
  status.textContent = statusText(stored.connectionStatus, connectedNickname, stored.transportKind, stored.lastError);
}
function updateNicknamePreview() {
  try {
    const normalized = validatePairingCode(pairingCode.value);
    pairingCode.setCustomValidity("");
    profileNickname.textContent = createNicknameFromPairingCode(normalized);
  } catch (error) {
    pairingCode.setCustomValidity(error instanceof Error ? error.message : "Invalid pairing code");
    profileNickname.textContent = "invalid pairing code";
  }
}
pairingCode.addEventListener("input", updateNicknamePreview);
pairingCode.addEventListener("blur", () => {
  pairingCode.value = normalizePairingCode(pairingCode.value);
  updateNicknamePreview();
});
form.addEventListener("submit", (event) => {
  event.preventDefault();
  void (async () => {
    try {
      const normalizedUrl = new URL(brokerUrl.value);
      if (normalizedUrl.protocol !== "ws:" && normalizedUrl.protocol !== "wss:") {
        throw new Error("Broker URL must start with ws:// or wss://");
      }
      const mode = transportMode.value;
      if (mode !== "native" && mode !== "websocket") throw new Error("Invalid transport mode");
      const customizedPairing = await saveCustomPairingCode(pairingCode.value);
      pairingCode.value = customizedPairing.pairingCode;
      await saveSettings({
        brokerUrl: normalizedUrl.toString(),
        transportMode: mode
      });
      await chrome.storage.local.set({ connectionStatus: "connecting", transportKind: null, lastError: null });
      await chrome.runtime.sendMessage({ type: "relay:reconnect" });
    } catch (error) {
      await chrome.storage.local.set({
        connectionStatus: "error",
        lastError: error instanceof Error ? error.message : "Connection failed"
      });
    }
  })();
});
reset.addEventListener("click", () => {
  void (async () => {
    await resetIdentity();
    await chrome.runtime.sendMessage({ type: "relay:reset" });
    await refresh();
  })();
});
chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === "local" && [
    "connectionStatus",
    "endpointNickname",
    "targetAlias",
    "profilePairingCode",
    "proposedNickname",
    "transportKind",
    "lastError"
  ].some((key) => key in changes)) {
    void refresh();
  }
});
void refresh();
//# sourceMappingURL=options.js.map
