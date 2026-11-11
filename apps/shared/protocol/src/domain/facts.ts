import type {
  BrowserRef,
  EventCursor,
  ExtensionRef,
  LineageRef,
  RequestRef,
  SessionRef,
  TabRef,
  WindowRef,
  WorkspaceRef
} from './references.js';

export type RequestLifecycleState = 'queued' | 'running' | 'succeeded' | 'failed' | 'uncertain';
export type RequestDisposition = 'accepted' | 'rejected';
export type ImmediateDisposition = 'complete' | 'rejected';
export type EndpointCondition = 'usable' | 'busy' | 'offline' | 'unresponsive' | 'failing';
export type ConnectionCondition = 'connected' | 'disconnected';
export type FactFreshness = 'current' | 'stale' | 'unknown';
export type RequestPauseCause =
  | 'extension_disconnected'
  | 'manual_workspace_stop'
  | 'endpoint_killed'
  | 'input_recovery_required'
  | 'user_confirmation_required';
export type WorkspacePauseReason =
  | 'manual_workspace_stop'
  | 'endpoint_killed';
export type WorkspaceCondition = 'ready' | 'paused' | 'unavailable' | 'terminated';
export type CallerWorkspaceRelationship = 'owner' | 'lineage_member' | 'none';
export type BrowserProcessCondition = 'running' | 'not_running' | 'unknown';
export type TabAdoptionSource = 'workspace_initial' | 'agent_created' | 'same_window_child' | 'new_window_child';
export type WorkspaceRequestTool =
  | 'create_browser_tab'
  | 'send_cdp_command'
  | 'terminate_workspace'
  | 'resolve_browser_request'
  | 'stop_workspace_automation'
  | 'resume_workspace_automation';

export interface CallerFacts {
  readonly session_ref: SessionRef;
  readonly lineage_ref: LineageRef;
  readonly parent_session_ref: SessionRef | null;
}

export interface RequestCheckpoint {
  readonly name: string;
  readonly recorded_at: string;
  readonly details: Readonly<Record<string, unknown>>;
}

export interface RequestPauseCondition {
  readonly reason: RequestPauseCause;
  readonly paused_at: string;
}

export interface ManagedTabTarget {
  readonly kind: 'tab';
  readonly tab_ref: TabRef;
}

export interface ExtensionFacts {
  readonly extension_ref: ExtensionRef;
  readonly endpoint_nickname: string;
  readonly connection_condition: ConnectionCondition;
  readonly extension_version: string | null;
  readonly protocol_version: string | null;
  readonly last_seen_at: string | null;
  readonly browser_ref: BrowserRef | null;
}

export interface BrowserFacts {
  readonly browser_ref: BrowserRef;
  readonly extension_ref: ExtensionRef;
  readonly endpoint_nickname: string;
  readonly process_condition: BrowserProcessCondition;
  readonly reported_product: string | null;
  readonly reported_version: string | null;
  readonly reported_platform: string | null;
  readonly observed_at: string;
}

export interface EndpointFacts {
  readonly endpoint_nickname: string;
  readonly extension_ref: ExtensionRef;
  readonly browser_ref: BrowserRef | null;
  readonly condition: EndpointCondition;
  readonly killed: boolean;
  readonly workspace_ownership_frozen: boolean;
  readonly observed_at: string;
}

export interface WindowFacts {
  readonly window_ref: WindowRef;
  readonly endpoint_nickname: string;
  readonly eligible_for_workspace: boolean;
  readonly eligibility_reason: string | null;
  readonly last_focused_at: string | null;
  readonly observed_at: string;
}

export interface WorkspaceFacts {
  readonly input_recovery?: InputRecoveryFacts | null;
  readonly workspace_ref: WorkspaceRef;
  readonly endpoint_nickname: string;
  readonly window_ref: WindowRef;
  readonly parent_workspace_ref: WorkspaceRef | null;
  readonly condition: WorkspaceCondition;
  readonly automation_pause_reasons: readonly WorkspacePauseReason[];
  readonly owner_session_ref: SessionRef;
  readonly lineage_ref: LineageRef;
  readonly caller_relationship: CallerWorkspaceRelationship;
  readonly tab_count: number;
  readonly updated_at: string;
}

export interface TabFacts {
  readonly interaction_policy?: InteractionPolicyFacts;
  readonly workspace_ref: WorkspaceRef;
  readonly tab_ref: TabRef;
  readonly window_ref: WindowRef;
  readonly adoption_source: TabAdoptionSource;
  readonly title: string;
  readonly url: string;
  readonly active: boolean;
  readonly initial_event_cursor: EventCursor;
}

export interface InteractionPolicyFacts {
  readonly mode: 'standard' | 'input_only' | 'unavailable';
  readonly domain: string;
  readonly matched_rule: string | null;
  readonly matched_domain: string | null;
  readonly revision: string | null;
  readonly diagnostic: string | null;
}

export interface InputRecoveryFacts {
  readonly recovery_ref: string;
  readonly workspace_ref: WorkspaceRef;
  readonly tab_ref: TabRef;
  readonly owner_session_ref: SessionRef;
  readonly status: 'held' | 'paused' | 'uncertain';
  readonly pause_reason: string | null;
  readonly held_inputs: readonly string[];
  readonly last_confirmed_step: string | null;
  readonly pending_request_ref: RequestRef | null;
}

export interface CapabilityFacts {
  readonly method: string;
  readonly available: boolean;
  readonly reason: string | null;
  readonly observed_at: string;
}

export interface RequestSummaryFacts {
  readonly workspace_ref: WorkspaceRef;
  readonly request_ref: RequestRef;
  readonly tool: WorkspaceRequestTool;
  readonly state: RequestLifecycleState;
  readonly pause_condition: RequestPauseCondition | null;
  readonly submitted_at: string;
  readonly updated_at: string;
}
