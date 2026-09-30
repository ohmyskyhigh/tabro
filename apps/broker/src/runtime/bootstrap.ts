import pino, { type Logger } from 'pino';
import { BrokerCore, OctopusBroker } from '../core/index.js';
import { ExtensionGateway } from '../extension-relay/index.js';
import { McpGateway } from '../mcp/index.js';
import { SqliteRelayStore } from '../storage/index.js';
import { OCTOPUS_VERSION } from '../../../shared/protocol/src/version.js';
import type { RelayConfig } from './config.js';
import { ChromeLauncher } from '../profiles/chrome-launcher.js';
import { ProfileManager } from '../profiles/profile-manager.js';

const SERVICE_VERSION = OCTOPUS_VERSION;
const MCP_CONTRACT_VERSION = '2';
const RELAY_PROTOCOL_VERSION = '2';

export interface RelayApplication {
  profileManager: ProfileManager | null;
  store: SqliteRelayStore;
  /** Canonical source-of-truth broker used by the public MCP contract. */
  broker: OctopusBroker;
  /** Migration bridge retained only while relay-v1 extensions can still connect. */
  legacyBroker: BrokerCore;
  extensionGateway: ExtensionGateway;
  mcpGateway: McpGateway;
  adminToken: string;
  logger: Logger;
  start(): Promise<void>;
  stop(): Promise<void>;
}

export function createRelayApplication(config: RelayConfig): RelayApplication {
  const logger = pino({
    level: config.logLevel,
    redact: [
      'req.headers.authorization',
      '*.token',
      '*.pairingCode',
      '*.publicKeyJwk',
      '*.credential'
    ]
  });
  const store = new SqliteRelayStore(config.dbPath);
  const existingAdmin = store.authenticateAgent(config.adminToken);
  if (!existingAdmin) {
    store.createAgent('Local relay administrator', [
      'broker:admin',
      'targets:read',
      'sessions:write',
      'browser:read',
      'browser:write'
    ], config.adminToken);
  }
  if (config.profiles) {
    const admin = store.authenticateAgent(config.adminToken)!;
    store.updateAgentScopes(admin.principalId, [...admin.scopes, 'profiles:read', 'profiles:manage']);
  }

  const broker = new OctopusBroker(store.canonical);
  const profileManager: ProfileManager | null = config.profiles ? new ProfileManager(store, new ChromeLauncher(config.profiles), endpointRef => extensionGateway.connection(endpointRef), 120_000, config.profiles.launchesEnabled !== false) : null;
  if (profileManager) broker.setProfileManager(profileManager);
  const legacyBroker = new BrokerCore(store, {
    heartbeatTimeoutMs: config.heartbeatTimeoutMs,
    errorThreshold: config.errorThreshold
  });
  const extensionGateway = new ExtensionGateway(
    legacyBroker,
    store,
    { host: config.host, port: config.wsPort, serviceVersion: SERVICE_VERSION },
    broker,
    profileManager?.grants
  );
  legacyBroker.setTransport(extensionGateway);

  const health = (): Record<string, unknown> => {
    const logical = store.canonical.logical.scanLogicalRecovery();
    const requests = store.canonical.requests.scanRequestRecovery().requests;
    const connectedEndpointRefs = new Set(
      logical.liveConnections
        .filter((connection) => extensionGateway.connection(connection.endpointRef)?.connected === true)
        .map((connection) => connection.endpointRef)
    );
    return {
      serviceVersion: SERVICE_VERSION,
      brokerCondition: 'ready',
      connectedEndpoints: connectedEndpointRefs.size,
      endpointCount: logical.endpoints.length,
      activeWorkspaceCount: logical.activeWorkspaces.length,
      openRequestCount: requests.filter((request) => request.publiclyVisible).length,
      relayProtocolVersion: RELAY_PROTOCOL_VERSION,
      mcpContractVersion: MCP_CONTRACT_VERSION,
      legacyRelayV1Enabled: true
    };
  };

  const mcpGateway = new McpGateway(broker, store, {
    host: config.host,
    port: config.mcpPort,
    serviceVersion: SERVICE_VERSION,
    health,
    onError: (error) => logger.error({ error }, 'MCP gateway failure')
  });

  let sweepTimer: NodeJS.Timeout | null = null;
  let extensionStarted = false;
  let mcpStarted = false;
  let storeClosed = false;

  return {
    profileManager,
    store,
    broker,
    legacyBroker,
    extensionGateway,
    mcpGateway,
    adminToken: config.adminToken,
    logger,
    async start() {
      if (storeClosed) throw new Error('Cannot restart a closed relay application.');
      if (extensionStarted || mcpStarted) throw new Error('Relay application is already started.');
      try {
        await profileManager?.reconcile();
        legacyBroker.recover();
        broker.recover();
        await extensionGateway.start();
        extensionStarted = true;
        await mcpGateway.start();
        mcpStarted = true;
        profileManager?.startObserving();
        sweepTimer = setInterval(() => {
          legacyBroker.sweep();
          extensionGateway.sweepHeartbeat(config.heartbeatTimeoutMs);
        }, Math.min(1_000, Math.max(250, Math.floor(config.heartbeatTimeoutMs / 4))));
        sweepTimer.unref();
        logger.info({
          serviceVersion: SERVICE_VERSION,
          mcp: mcpGateway.address(),
          relay: extensionGateway.address(),
          ...health()
        }, 'Tabro started');
      } catch (error) {
        if (mcpStarted) {
          await mcpGateway.stop().catch((stopError: unknown) => {
            logger.error({ error: stopError }, 'Failed to roll back MCP gateway startup');
          });
          mcpStarted = false;
        }
        if (extensionStarted) {
          await extensionGateway.stop().catch((stopError: unknown) => {
            logger.error({ error: stopError }, 'Failed to roll back extension gateway startup');
          });
          extensionStarted = false;
        }
        throw error;
      }
    },
    async stop() {
      broker.beginShutdown();
      await profileManager?.shutdown();
      if (sweepTimer) {
        clearInterval(sweepTimer);
        sweepTimer = null;
      }
      if (mcpStarted) {
        await mcpGateway.stop();
        mcpStarted = false;
      }
      if (extensionStarted) {
        await extensionGateway.stop();
        extensionStarted = false;
      }
      if (!storeClosed) {
        await broker.waitForIdle();
        store.close();
        storeClosed = true;
      }
      logger.info('Tabro stopped');
    }
  };
}
