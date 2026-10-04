import { afterEach, describe, expect, it } from 'vitest';
import type { Client } from '@modelcontextprotocol/client';
import { createRelayApplication, type RelayApplication } from '../../apps/broker/src/runtime/bootstrap.js';
import { SimulatedV2Extension, waitFor, connectAgent, call, ticketRef, waitTicket } from '../helpers/simulated-v2-extension.js';

describe('multi-agent / multi-extension canonical real transport path', () => {
  let app: RelayApplication | null = null;
  const clients: Client[] = [];
  const extensions: SimulatedV2Extension[] = [];

  afterEach(async () => {
    for (const client of clients.splice(0)) await client.close();
    for (const extension of extensions.splice(0)) await extension.close();
    if (app) await app.stop();
    app = null;
  });

  it('isolates three agent sessions while relaying CDP to three designated browser-profile endpoints', async () => {
    const adminToken = 'e2e-admin-token-that-is-long-enough';
    app = createRelayApplication({
      host: '127.0.0.1',
      mcpPort: 0,
      wsPort: 0,
      dbPath: ':memory:',
      logLevel: 'silent',
      heartbeatTimeoutMs: 5_000,
      errorThreshold: 3,
      leaseTtlMs: 60_000,
      adminToken
    });
    const agentRecords = ['a', 'b', 'c'].map((name) => app!.store.createAgent(
      `agent-${name}`,
      ['targets:read', 'sessions:write', 'browser:read', 'browser:write']
    ));
    await app.start();
    const mcpPort = app.mcpGateway.address().port;
    const relayPort = app.extensionGateway.address().port;
    const aliases = ['mintwave', 'calmreef', 'brightstar'];
    const pairingCodes = ['MINT-WAVE', 'CALM-REEF', 'BRIGHT-STAR'];

    for (const [index, alias] of aliases.entries()) {
      const extension = new SimulatedV2Extension(
        `fixture-${String.fromCharCode(65 + index)}`,
        100 + index,
        200 + index,
        300 + index * 10
      );
      extensions.push(extension);
      await extension.pair(`ws://127.0.0.1:${relayPort}/relay`, alias, pairingCodes[index]!);
    }
    await waitFor(() => aliases.every((alias) => {
      const endpoint = app!.store.canonical.logical.getEndpointByNickname(alias);
      return endpoint !== null && app!.store.canonical.logical.listWindows(endpoint.endpointRef).length === 1;
    }));

    for (const [index, record] of agentRecords.entries()) {
      clients.push(await connectAgent(mcpPort, record.token, `agent-session-${index}`));
    }

    for (const client of clients) {
      const listed = await call(client, 'list_browser_profiles', {});
      const profiles = (listed.facts as { profiles: { endpoint_nickname: string; ownership: string; ready: boolean }[] }).profiles;
      expect(profiles.map(profile => profile.endpoint_nickname).sort()).toEqual([...aliases].sort());
      expect(profiles.every(profile => profile.ownership === 'user' && profile.ready)).toBe(true);
    }

    const workspaceTickets = await Promise.all(aliases.map((alias, index) => call(
      clients[index]!,
      'request_browser_workspace',
      { required_workspace_count: 1, designated_endpoints: [{ endpoint_nickname: alias }] }
    )));
    const workspaceResults = await Promise.all(workspaceTickets.map((accepted, index) =>
      waitTicket(clients[index]!, ticketRef(accepted))));
    expect(
      workspaceResults.map((ticket) => ticket.state),
      JSON.stringify(workspaceResults, null, 2)
    ).toEqual(['succeeded', 'succeeded', 'succeeded']);

    const assignments = workspaceResults.map((ticket) => {
      const result = ticket.result as { facts: { resolved: Array<{
        workspace: { workspace_ref: string };
        tabs: Array<{ tab_ref: string }>;
      }> } };
      return {
        workspaceRef: result.facts.resolved[0]!.workspace.workspace_ref,
        tabRef: result.facts.resolved[0]!.tabs[0]!.tab_ref
      };
    });

    const commandReceipts = await Promise.all(assignments.map((assignment, index) => call(
      clients[index]!,
      'send_cdp_command',
      {
        workspace_ref: assignment.workspaceRef,
        target: { kind: 'tab', tab_ref: assignment.tabRef },
        method: 'Runtime.evaluate',
        params: { expression: `${index} + 1` }
      }
    )));
    const commands = await Promise.all(commandReceipts.map((accepted, index) =>
      waitTicket(clients[index]!, ticketRef(accepted))));
    expect(commands.map((ticket) => {
      const result = ticket.result as { facts: { command: { result: { marker: string } } } };
      return result.facts.command.result.marker;
    })).toEqual(['fixture-A', 'fixture-B', 'fixture-C']);
    expect(extensions.map((extension) => extension.executedCdp)).toEqual([
      ['Runtime.evaluate'],
      ['Runtime.evaluate'],
      ['Runtime.evaluate']
    ]);

    const crossSession = await call(clients[0]!, 'send_cdp_command', {
      workspace_ref: assignments[1]!.workspaceRef,
      target: { kind: 'tab', tab_ref: assignments[1]!.tabRef },
      method: 'Runtime.evaluate',
      params: { expression: '42' }
    });
    expect(crossSession).toMatchObject({
      disposition: 'rejected',
      problem: { code: 'WORKSPACE_NOT_OWNED' }
    });
    expect(extensions[1]!.executedCdp).toEqual(['Runtime.evaluate']);
  });
});
