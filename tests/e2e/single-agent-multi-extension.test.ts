import { afterEach, describe, expect, it } from 'vitest';
import type { Client } from '@modelcontextprotocol/client';
import { createRelayApplication, type RelayApplication } from '../../apps/broker/src/runtime/bootstrap.js';
import { SimulatedV2Extension, waitFor, connectAgent, call, ticketRef, waitTicket } from '../helpers/simulated-v2-extension.js';

describe('one Agent with three simulated extensions', () => {
  let app: RelayApplication;
  let client: Client;
  const extensions: SimulatedV2Extension[] = [];
  afterEach(async () => { app?.broker.beginShutdown(); await client?.close(); for (const extension of extensions.splice(0)) await extension.close(); await app?.stop(); });
  it('keeps three workspace owners identical, routes correctly and lets A/C finish while B waits', async () => {
    const token = 'one-agent-three-extensions-test-token';
    app = createRelayApplication({ host: '127.0.0.1', mcpPort: 0, wsPort: 0, dbPath: ':memory:', logLevel: 'silent', heartbeatTimeoutMs: 5000, errorThreshold: 3, leaseTtlMs: 60000, adminToken: token });
    await app.start(); client = await connectAgent(app.mcpGateway.address().port, token, 'one-agent');
    const names = ['mintwave', 'calmreef', 'brightstar'];
    for (let i = 0; i < 3; i++) {
      const extension = new SimulatedV2Extension(['A','B','C'][i]!, 100 + i, 200 + i, 300 + i * 10);
      extensions.push(extension);
      await extension.pair(`ws://127.0.0.1:${app.extensionGateway.address().port}/relay`, names[i]!, ['MINT-WAVE','CALM-REEF','BRIGHT-STAR'][i]!);
    }
    await waitFor(() => names.every(name => {
      const endpoint = app.store.canonical.logical.getEndpointByNickname(name);
      return endpoint && app.store.canonical.logical.listWindows(endpoint.endpointRef).length === 1;
    }));
    const insufficient = await call(client, 'request_browser_workspace', { required_workspace_count: 4, designated_endpoints: [] });
    expect(insufficient.disposition).toBe('rejected');
    const duplicate = await call(client, 'request_browser_workspace', { required_workspace_count: 1, designated_endpoints: [{ endpoint_nickname: names[0] }, { endpoint_nickname: names[0] }] });
    expect((await waitTicket(client, ticketRef(duplicate))).state).toBe('succeeded');
    expect(app.store.canonical.logical.scanLogicalRecovery().activeWorkspaces).toHaveLength(1);
    const duplicateWorkspace = app.store.canonical.logical.scanLogicalRecovery().activeWorkspaces[0]!;
    expect((await waitTicket(client, ticketRef(await call(client, 'terminate_workspace', { workspace_ref: duplicateWorkspace.workspaceRef })))).state).toBe('succeeded');
    extensions[2]!.disconnectBeforeNextTab = true;
    const accepted = await call(client, 'request_browser_workspace', { required_workspace_count: 3, designated_endpoints: names.map(endpoint_nickname => ({ endpoint_nickname })) });
    await waitFor(() => app.store.canonical.requests.getRequest(ticketRef(accepted))?.pauseCondition === 'extension_disconnected');
    const preserved = app.store.canonical.logical.scanLogicalRecovery().activeWorkspaces.filter(w => w.endpointRef !== app.store.canonical.logical.getEndpointByNickname(names[2]!)!.endpointRef).map(w => w.workspaceRef);
    expect(preserved).toHaveLength(2);
    await extensions[2]!.pair(`ws://127.0.0.1:${app.extensionGateway.address().port}/relay`, names[2]!, 'BRIGHT-STAR');
    const ticket = await waitTicket(client, ticketRef(accepted)); expect(ticket.state).toBe('succeeded');
    const resolved = (ticket.result as { facts: { resolved: Array<{workspace:{workspace_ref:string};tabs:Array<{tab_ref:string}>}> } }).facts.resolved;
    expect(new Set(app.store.canonical.logical.scanLogicalRecovery().activeWorkspaces.map(w => w.ownerSessionRef)).size).toBe(1);
    expect(app.store.canonical.logical.scanLogicalRecovery().activeWorkspaces).toHaveLength(3);
    expect(resolved.slice(0,2).map(r => r.workspace.workspace_ref).sort()).toEqual(preserved.sort());
    extensions[1]!.cdpDelayMs = 800;
    const args = (i: number) => ({ workspace_ref: resolved[i]!.workspace.workspace_ref, target: { kind: 'tab', tab_ref: resolved[i]!.tabs[0]!.tab_ref }, method: 'Runtime.evaluate', params: { expression: 'document.title' } });
    const receipts = await Promise.all([0,1,2].map(i => call(client, 'send_cdp_command', args(i))));
    const bSecond = await call(client, 'send_cdp_command', args(1));
    const finished = await Promise.all([0,2].map(i => waitTicket(client, ticketRef(receipts[i]!))));
    expect(finished.map(t => t.state)).toEqual(['succeeded','succeeded']);
    expect(app.store.canonical.requests.getRequest(ticketRef(receipts[1]!))?.state).toBe('running');
    expect(extensions[1]!.executedCdp).toHaveLength(1);
    await waitTicket(client, ticketRef(bSecond)); expect(extensions[1]!.executedCdp).toHaveLength(2);
    const mixed = await call(client, 'send_cdp_command', { ...args(0), target: args(1).target });
    expect(mixed.disposition).toBe('rejected');
    expect(extensions.map(e => e.executedCdp.length)).toEqual([1,2,1]);
  });
});
