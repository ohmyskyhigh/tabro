export const MCP_CONTRACT_VERSION = '5' as const;

export const MCP_ASYNC_TOOL_NAMES = [
  'set_browser_proxy',
  'clear_browser_proxy',
  'check_browser_proxy',
  'create_browser_profile',
  'open_browser_profile',
  'stop_browser_profile',
  'request_browser_workspace',
  'create_browser_tab',
  'send_cdp_command',
  'take_over_workspace',
  'terminate_workspace',
  'resolve_browser_request',
  'stop_workspace_automation',
  'resume_workspace_automation',
  'kill_browser_endpoint',
  'resume_browser_endpoint'
] as const;

export const MCP_READ_TOOL_NAMES = [
  'get_browser_proxy',
  'list_browser_profiles',
  'get_browser_context',
  'read_cdp_events',
  'get_browser_request'
] as const;

export const MCP_IMMEDIATE_CONTROL_TOOL_NAMES = ['close_browser_request'] as const;

export const MCP_TOOL_NAMES = [
  'get_browser_proxy',
  'list_browser_profiles',
  'set_browser_proxy',
  'clear_browser_proxy',
  'check_browser_proxy',
  'create_browser_profile',
  'open_browser_profile',
  'stop_browser_profile',
  'get_browser_context',
  'request_browser_workspace',
  'create_browser_tab',
  'send_cdp_command',
  'read_cdp_events',
  'get_browser_request',
  'take_over_workspace',
  'terminate_workspace',
  'resolve_browser_request',
  'close_browser_request',
  'stop_workspace_automation',
  'resume_workspace_automation',
  'kill_browser_endpoint',
  'resume_browser_endpoint'
] as const;

export type McpAsyncToolName = (typeof MCP_ASYNC_TOOL_NAMES)[number];
export type McpReadToolName = (typeof MCP_READ_TOOL_NAMES)[number];
export type McpImmediateControlToolName = (typeof MCP_IMMEDIATE_CONTROL_TOOL_NAMES)[number];
export type McpToolName = (typeof MCP_TOOL_NAMES)[number];
export type McpToolExecution = 'asynchronous' | 'read' | 'immediate_control';

export interface McpToolDefinition<Name extends McpToolName = McpToolName> {
  readonly name: Name;
  readonly description: string;
  readonly execution: McpToolExecution;
  readonly inputSchemaRef: `#/$defs/${Name}_input`;
  readonly outputSchemaRef: `#/$defs/${Name}_output`;
}

const DESCRIPTIONS: Readonly<Record<McpToolName, string>> = {
  get_browser_proxy: 'Read saved proxy configuration, effective application and the last browser exit-IP observation for a Profile.',
  set_browser_proxy: 'Save HTTP, HTTPS or SOCKS5 routing only for a closed broker-owned Profile. Applies on the next explicit open; never opens or closes Chrome. Uses a provisioned credential_ref, never passwords. User-owned Profiles are unsupported.',
  clear_browser_proxy: 'Save removal of Tabro proxy routing only for a closed broker-owned Profile. The next explicit open restores underlying browser settings. Never opens or closes Chrome. User-owned Profiles are unsupported.',
  check_browser_proxy: 'Check an applied proxy on an open broker-owned Profile through a bounded browser-originated exit-IP request. Returns the observed IP, revision, time and latency.',

  list_browser_profiles: 'List every extension-registered browser Profile, including offline ones. Use endpoint_nickname (pairing alias) as its only name. Ownership: broker can launch it through MCP; user opens Chrome manually. Both support workspaces while connected.',
  create_browser_profile: 'Create a Profile with an idempotency key, launch Chrome and connect its extension through a durable request. The extension assigns its pairing alias, returned as endpoint_nickname; no separate display name is accepted.',
  open_browser_profile: 'Ensure one broker-owned Profile is running and its authenticated extension is ready. User-owned Profiles must be opened manually, then accessed through a workspace.',
  stop_browser_profile: 'Normally close a broker-owned Profile after checking active work, retaining its browser data and identity. Does not close user-owned Chrome.',
  get_browser_context: 'Read one narrow, paginated broker, endpoint, window, capability, workspace, tab, or request-summary view.',
  request_browser_workspace: 'Acquire an exact number of logical workspaces on distinct eligible browser-profile endpoints.',
  create_browser_tab: 'Create and register one managed tab in an owned workspace.',
  send_cdp_command: 'Submit one extension-supported raw CDP command to one managed tab.',
  read_cdp_events: 'Read retained raw CDP events from a required broker-issued tab cursor.',
  get_browser_request: 'Read one authority-visible request ticket by its broker-issued reference.',
  take_over_workspace: 'Transfer one exactly identified workspace and its owner-governed public tickets.',
  terminate_workspace: 'Fence new work, reconcile dispatched work, archive the tab group, and end workspace control.',
  resolve_browser_request: 'Resolve one owner-visible request paused for user confirmation.',
  close_browser_request: 'Remove one terminal ticket from public discovery while retaining audit history.',
  stop_workspace_automation: 'Add the manual-stop pause cause to one workspace.',
  resume_workspace_automation: 'Reconcile one workspace and clear only its manual-stop pause cause.',
  kill_browser_endpoint: 'Pause every active workspace on one entirely owned browser-profile endpoint.',
  resume_browser_endpoint: 'Reconcile one entirely owned endpoint and clear only its endpoint-kill pause cause.'
};

const asyncNames = new Set<string>(MCP_ASYNC_TOOL_NAMES);
const readNames = new Set<string>(MCP_READ_TOOL_NAMES);

export const MCP_TOOL_CATALOG: readonly McpToolDefinition[] = Object.freeze(
  MCP_TOOL_NAMES.map((name): McpToolDefinition => ({
    name,
    description: DESCRIPTIONS[name],
    execution: asyncNames.has(name) ? 'asynchronous' : readNames.has(name) ? 'read' : 'immediate_control',
    inputSchemaRef: `#/$defs/${name}_input`,
    outputSchemaRef: `#/$defs/${name}_output`
  }))
);

export const MCP_TOOL_BY_NAME: Readonly<Record<McpToolName, McpToolDefinition>> = Object.freeze(
  Object.fromEntries(MCP_TOOL_CATALOG.map((definition) => [definition.name, definition])) as Record<
    McpToolName,
    McpToolDefinition
  >
);

export function isMcpToolName(value: string): value is McpToolName {
  return Object.hasOwn(MCP_TOOL_BY_NAME, value);
}
