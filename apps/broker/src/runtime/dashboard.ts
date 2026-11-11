import { DashboardCommandSchema, DashboardSnapshotSchema, type DashboardCommand, type DashboardSnapshot } from '../../../shared/protocol/src/dashboard.js';
import { OCTOPUS_VERSION } from '../../../shared/protocol/src/version.js';
import type { OctopusBroker } from '../core/index.js';
import type { SqliteRelayStore } from '../storage/index.js';
import type { BrowserRulesFile } from './browser-rules.js';

export class DashboardService {
  constructor(private readonly broker: OctopusBroker, private readonly store: SqliteRelayStore,
    private readonly rules: BrowserRulesFile) {}

  handle(endpointRef: string, rawCommand: DashboardCommand): DashboardSnapshot {
    const command = DashboardCommandSchema.parse(rawCommand);
    const endpoint = this.store.canonical.logical.getEndpoint(endpointRef);
    if (!endpoint) throw new Error('PROFILE_NOT_FOUND: Reconnect this extension.');
    const evidence = { runtimeName: 'Tabro dashboard', runtimeSessionKey: endpointRef };
    if (command.action === 'rules.save') this.rules.replace(command.configuration, command.expectedRevision);
    const profiles: unknown[] = [];
    let cursor: string | null = null;
    do {
      const result = this.broker.listBrowserProfiles({ limit: 100, ...(cursor ? { cursor } : {}) }, evidence);
      if (result.disposition !== 'complete') throw new Error('PROFILE_LIST_UNAVAILABLE: Refresh after the Broker reconnects.');
      const facts = result.facts as { profiles: unknown[]; next_cursor: string | null };
      profiles.push(...facts.profiles); cursor = facts.next_cursor;
    } while (cursor);
    const policy = this.rules.refresh();
    return DashboardSnapshotSchema.parse({ brokerVersion: OCTOPUS_VERSION,
      currentProfileRef: this.store.profiles.forEndpoint(endpointRef)?.profileRef ?? endpointRef,
      profiles, rules: { configuration: policy?.configuration ?? null, revision: policy?.revision ?? null, diagnostic: this.rules.diagnostic }
    });
  }
}
