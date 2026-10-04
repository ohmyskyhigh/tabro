export type ProfileOperation = 'create_browser_profile' | 'open_browser_profile' | 'stop_browser_profile';
export type BrowserState = 'starting' | 'running' | 'stopping' | 'stopped' | 'unknown';
export type ExtensionState = 'unknown' | 'missing' | 'connecting' | 'connected' | 'disconnected';

export interface ManagedProfile {
  profileRef: string;
  principalId: string;
  dataDirKey: string;
  runtimeRef: string;
  endpointRef: string | null;
  identityHash: string | null;
  problemCode: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ManagedBrowserInstance {
  instanceRef: string;
  profileRef: string;
  generation: number;
  browserState: BrowserState;
  extensionState: ExtensionState;
  pid: number | null;
  processCreatedAt: string | null;
  executablePath: string | null;
  dataDir: string | null;
  managementUrl: string | null;
  observedAt: string;
  endedAt: string | null;
}

/** Launch records enrich extension discovery; they do not define its membership. */
export interface ProfileCatalogRepository {
  forEndpoint(endpointRef: string): ManagedProfile | null;
  currentInstance(profileRef: string): ManagedBrowserInstance | null;
}

export interface ProfileAuthority {
  principalId: string;
  scopes: readonly string[];
}

export interface ProfileRequest {
  requestRef: string;
  profileRef: string;
  principalId: string;
}

export interface ProfileLease {
  profileRef: string;
  ownerRef: string;
  generation: number;
  expiresAt: number;
}

export interface BootstrapGrant {
  grantRef: string;
  profileRef: string;
  instanceRef: string;
  generation: number;
  secretHash: string;
  expiresAt: number;
  consumedAt: number | null;
}

export class ProfileError extends Error {
  constructor(readonly code: string, message = code) { super(message); }
}
