import { describe, expect, it } from 'vitest';
import {
  MCP_ASYNC_TOOL_NAMES,
  MCP_CONTRACT_SCHEMA_BUNDLE,
  MCP_IMMEDIATE_CONTROL_TOOL_NAMES,
  MCP_READ_TOOL_NAMES,
  MCP_TOOL_CATALOG,
  MCP_TOOL_NAMES,
  PublicProblemCodes,
  mcpToolInputJsonSchemas,
  mcpToolInputSchemas,
  mcpToolOutputJsonSchemas,
  mcpToolOutputSchemas,
  safeParseMcpToolInput,
  safeParseMcpToolOutput,
  type McpToolName
} from '../../apps/shared/protocol/src/index.js';

const refs = {
  session: 'session-ref',
  lineage: 'lineage-ref',
  workspace: 'workspace-ref',
  tab: 'tab-ref',
  request: 'request-ref',
  cursor: 'cursor-ref'
} as const;

const validInputs: Readonly<Record<McpToolName, unknown>> = {
  list_browser_profiles: {},
  create_browser_profile: { display_name: 'Alice', idempotency_key: 'create-alice' },
  open_browser_profile: { profile_ref: 'profile-ref' },
  stop_browser_profile: { profile_ref: 'profile-ref' },
  get_browser_context: { view: { kind: 'broker' } },
  request_browser_workspace: { required_workspace_count: 1, designated_endpoints: [] },
  create_browser_tab: { workspace_ref: refs.workspace },
  send_cdp_command: {
    workspace_ref: refs.workspace,
    target: { kind: 'tab', tab_ref: refs.tab },
    method: 'Runtime.evaluate',
    params: { expression: 'document.title' }
  },
  read_cdp_events: {
    workspace_ref: refs.workspace,
    target: { kind: 'tab', tab_ref: refs.tab },
    cursor: refs.cursor,
    page_size: 25
  },
  get_browser_request: { request_ref: refs.request },
  take_over_workspace: {
    workspace_ref: refs.workspace,
    endpoint_nickname: 'Profile A',
    previous_owner_session_ref: 'old-session-ref'
  },
  terminate_workspace: { workspace_ref: refs.workspace },
  resolve_browser_request: { request_ref: refs.request, decision: 'confirmed_succeeded' },
  close_browser_request: { request_ref: refs.request },
  stop_workspace_automation: { workspace_ref: refs.workspace },
  resume_workspace_automation: { workspace_ref: refs.workspace },
  kill_browser_endpoint: { endpoint_nickname: 'Profile A' },
  resume_browser_endpoint: { endpoint_nickname: 'Profile A' }
};

const caller = {
  session_ref: refs.session,
  lineage_ref: refs.lineage,
  parent_session_ref: null
};

const payloadTooLargeProblem = {
  code: 'PAYLOAD_TOO_LARGE',
  message: 'The payload exceeds the active broker limit.',
  retryable: false,
  affected_target: null
};

function rejectedOutput() {
  return {
    contract_version: '2',
    disposition: 'rejected',
    observed_at: '2026-08-31T00:00:00.000Z',
    caller,
    problem: payloadTooLargeProblem,
    facts: null,
    available_actions: []
  };
}

function acceptedWorkspaceOutput(requestTool = 'request_browser_workspace') {
  return {
    contract_version: '2',
    disposition: 'accepted',
    observed_at: '2026-08-31T00:00:00.000Z',
    caller,
    problem: null,
    facts: {
      ticket: {
        request_ref: refs.request,
        state: 'queued',
        phase: 'accepted',
        checkpoint: {
          name: 'durably_accepted',
          recorded_at: '2026-08-31T00:00:00.000Z',
          details: {}
        },
        pause_condition: null,
        request: {
          tool: requestTool,
          arguments: { required_workspace_count: 1, designated_endpoints: [] }
        },
        submitted_at: '2026-08-31T00:00:00.000Z',
        started_at: null,
        finished_at: null,
        updated_at: '2026-08-31T00:00:00.000Z',
        result: null,
        failure: null,
        uncertainty: null
      }
    },
    available_actions: [
      {
        tool: 'get_browser_request',
        arguments: { request_ref: refs.request },
        required_arguments: []
      }
    ]
  };
}

describe('canonical MCP contract version 2', () => {
  it('publishes exactly eighteen tools and thirty-six validator roots', () => {
    expect(MCP_TOOL_NAMES).toHaveLength(18);
    expect(new Set(MCP_TOOL_NAMES).size).toBe(18);
    expect(MCP_ASYNC_TOOL_NAMES).toHaveLength(13);
    expect(MCP_READ_TOOL_NAMES).toHaveLength(4);
    expect(MCP_IMMEDIATE_CONTROL_TOOL_NAMES).toEqual(['close_browser_request']);
    expect(MCP_TOOL_CATALOG.map((tool) => tool.name)).toEqual([...MCP_TOOL_NAMES]);
    expect(Object.keys(mcpToolInputSchemas)).toEqual([...MCP_TOOL_NAMES]);
    expect(Object.keys(mcpToolOutputSchemas)).toEqual([...MCP_TOOL_NAMES]);
    expect(Object.keys(mcpToolInputJsonSchemas)).toEqual([...MCP_TOOL_NAMES]);
    expect(Object.keys(mcpToolOutputJsonSchemas)).toEqual([...MCP_TOOL_NAMES]);

    const definitions = (MCP_CONTRACT_SCHEMA_BUNDLE as { $defs: Record<string, unknown> }).$defs;
    for (const name of MCP_TOOL_NAMES) {
      expect(definitions[`${name}_input`]).toBeDefined();
      expect(definitions[`${name}_output`]).toBeDefined();
      expect(mcpToolInputJsonSchemas[name]).toHaveProperty('$defs');
      expect(mcpToolOutputJsonSchemas[name]).toHaveProperty('$defs');
    }

    const canonicalProblemCodes = (
      definitions.problem as { properties: { code: { enum: readonly string[] } } }
    ).properties.code.enum;
    expect(PublicProblemCodes).toEqual(canonicalProblemCodes);
  });

  it('accepts one canonical input body for every tool', () => {
    for (const name of MCP_TOOL_NAMES) {
      expect(safeParseMcpToolInput(name, validInputs[name]), name).toMatchObject({ success: true });
    }
  });

  it('publishes and enforces the broker pagination range', () => {
    expect(safeParseMcpToolInput('get_browser_context', {
      view: { kind: 'endpoints', conditions: [], page_size: 100, cursor: null }
    })).toMatchObject({ success: true });
    expect(safeParseMcpToolInput('get_browser_context', {
      view: { kind: 'endpoints', conditions: [], page_size: 101, cursor: null }
    }).success).toBe(false);

    expect(safeParseMcpToolInput('read_cdp_events', {
      ...validInputs.read_cdp_events as object,
      page_size: 100
    })).toMatchObject({ success: true });
    expect(safeParseMcpToolInput('read_cdp_events', {
      ...validInputs.read_cdp_events as object,
      page_size: 101
    }).success).toBe(false);
  });

  it('keeps all public inputs closed and rejects model-authored routing identifiers', () => {
    const forbiddenFields = ['runId', 'idempotencyKey', 'principalId', 'tabId'];
    for (const name of MCP_TOOL_NAMES) {
      for (const forbiddenField of forbiddenFields) {
        expect(
          safeParseMcpToolInput(name, { ...(validInputs[name] as object), [forbiddenField]: 'model-authored' }).success,
          `${name} accepted ${forbiddenField}`
        ).toBe(false);
      }
    }
  });

  it('accepts PAYLOAD_TOO_LARGE as a structured rejection for every output root', () => {
    for (const name of MCP_TOOL_NAMES) {
      expect(safeParseMcpToolOutput(name, rejectedOutput()), name).toMatchObject({ success: true });
    }
  });

  it('enforces the request and result tool discriminator selected by the output root', () => {
    expect(safeParseMcpToolOutput('request_browser_workspace', acceptedWorkspaceOutput())).toMatchObject({ success: true });
    expect(
      safeParseMcpToolOutput('request_browser_workspace', acceptedWorkspaceOutput('create_browser_tab')).success
    ).toBe(false);
  });

  it('requires the polling action to repeat the broker-issued request_ref', () => {
    const output = acceptedWorkspaceOutput();
    (output.available_actions[0]!.arguments as { request_ref: string }).request_ref = 'different-request-ref';
    expect(safeParseMcpToolOutput('request_browser_workspace', output).success).toBe(false);
  });
});
