import { z } from 'zod';

export const RELAY_PROTOCOL_V2 = 2 as const;
export const MAX_RELAY_V2_ENVELOPE_BYTES = 1024 * 1024;

export const RELAY_V2_MESSAGE_TYPES = [
  'HELLO',
  'CHALLENGE',
  'AUTH',
  'PAIRED',
  'READY',
  'HEARTBEAT',
  'INVENTORY_REQUEST',
  'INVENTORY_SNAPSHOT',
  'CREATE_TAB',
  'GROUP_TABS',
  'MOVE_TAB',
  'RENAME_GROUP',
  'ATTACH_DEBUGGER',
  'SEND_CDP',
  'DETACH_DEBUGGER',
  'RECONCILE_ATTEMPT',
  'ACK',
  'OPERATION_RESULT',
  'CDP_EVENT',
  'DEBUGGER_DETACHED',
  'ERROR'
] as const;

export type RelayV2MessageType = (typeof RELAY_V2_MESSAGE_TYPES)[number];

const UuidSchema = z.string().uuid();
const TimestampSchema = z.string().datetime();
const GenerationSchema = z.number().int().nonnegative();
const PositiveGenerationSchema = z.number().int().positive();
const BrowserIdSchema = z.number().int().nonnegative();
const JsonObjectSchema = z.record(z.string(), z.json());

export const RelayV2EndpointIdentitySchema = UuidSchema;
export const RelayV2AttemptIdSchema = UuidSchema;
export const RelayV2PairingCodeSchema = z.string().regex(/^[A-Z]{3,8}-[A-Z]{3,8}$/);

const JwkSchema = z.strictObject({
  kty: z.string().min(1).max(32),
  crv: z.string().min(1).max(32).optional(),
  x: z.string().min(1).max(4096).optional(),
  y: z.string().min(1).max(4096).optional(),
  n: z.string().min(1).max(8192).optional(),
  e: z.string().min(1).max(64).optional(),
  ext: z.boolean().optional(),
  key_ops: z.array(z.string().min(1).max(32)).max(16).optional()
});

export const RelayV2WindowLocatorSchema = z.strictObject({
  windowId: BrowserIdSchema,
  windowGeneration: PositiveGenerationSchema
});

export const RelayV2TabLocatorSchema = z.strictObject({
  tabId: BrowserIdSchema,
  tabGeneration: PositiveGenerationSchema,
  windowId: BrowserIdSchema,
  windowGeneration: PositiveGenerationSchema
});

export const RelayV2TabGroupLocatorSchema = z.strictObject({
  tabGroupId: BrowserIdSchema,
  groupGeneration: PositiveGenerationSchema,
  windowId: BrowserIdSchema,
  windowGeneration: PositiveGenerationSchema
});

const ExpectedBaseSchema = z.strictObject({
  connectionGeneration: PositiveGenerationSchema,
  inventoryGeneration: GenerationSchema
});

const ExpectedTabSchema = z.strictObject({
  connectionGeneration: PositiveGenerationSchema,
  inventoryGeneration: GenerationSchema,
  tabGeneration: PositiveGenerationSchema
});

const ExpectedGroupSchema = z.strictObject({
  connectionGeneration: PositiveGenerationSchema,
  inventoryGeneration: GenerationSchema,
  groupGeneration: PositiveGenerationSchema
});

const ExpectedAttachmentSchema = z.strictObject({
  connectionGeneration: PositiveGenerationSchema,
  inventoryGeneration: GenerationSchema,
  tabGeneration: PositiveGenerationSchema,
  attachmentGeneration: GenerationSchema.nullable()
});

const ObservedGenerationsSchema = z.strictObject({
  connectionGeneration: PositiveGenerationSchema,
  inventoryGeneration: GenerationSchema,
  tabGeneration: PositiveGenerationSchema.nullable(),
  groupGeneration: PositiveGenerationSchema.nullable(),
  attachmentGeneration: PositiveGenerationSchema.nullable()
});

const BrowserDescriptorSchema = z.strictObject({
  product: z.string().min(1).max(128),
  version: z.string().min(1).max(128),
  userAgent: z.string().min(1).max(1024).nullable()
});

const DebuggerStateSchema = z.strictObject({
  attached: z.boolean(),
  attachmentGeneration: PositiveGenerationSchema.nullable(),
  protocolVersion: z.string().min(1).max(32).nullable()
});

export const RelayV2TabInventorySchema = z.strictObject({
  tabId: BrowserIdSchema,
  tabGeneration: PositiveGenerationSchema,
  windowId: BrowserIdSchema,
  groupId: BrowserIdSchema.nullable(),
  openerTabId: BrowserIdSchema.nullable(),
  active: z.boolean(),
  pinned: z.boolean(),
  discarded: z.boolean(),
  status: z.enum(['unloaded', 'loading', 'complete']).nullable(),
  url: z.string().max(65_536).nullable(),
  title: z.string().max(16_384).nullable(),
  debugger: DebuggerStateSchema
});

export const RelayV2TabGroupInventorySchema = z.strictObject({
  tabGroupId: BrowserIdSchema,
  groupGeneration: PositiveGenerationSchema,
  windowId: BrowserIdSchema,
  title: z.string().max(256),
  color: z.enum(['grey', 'blue', 'red', 'yellow', 'green', 'pink', 'purple', 'cyan', 'orange']),
  collapsed: z.boolean()
});

export const RelayV2WindowInventorySchema = z.strictObject({
  windowId: BrowserIdSchema,
  windowGeneration: PositiveGenerationSchema,
  focused: z.boolean(),
  incognito: z.boolean(),
  type: z.enum(['normal', 'popup', 'panel', 'app', 'devtools']),
  state: z.enum(['normal', 'minimized', 'maximized', 'fullscreen', 'locked-fullscreen']),
  groups: z.array(RelayV2TabGroupInventorySchema).max(512),
  tabs: z.array(RelayV2TabInventorySchema).max(2048)
});

const OperationTypeSchema = z.enum([
  'CREATE_TAB',
  'GROUP_TABS',
  'MOVE_TAB',
  'RENAME_GROUP',
  'ATTACH_DEBUGGER',
  'SEND_CDP',
  'DETACH_DEBUGGER',
  'RECONCILE_ATTEMPT'
]);

const DebuggerErrorSchema = z.strictObject({
  source: z.enum(['chrome_browser', 'chrome_debugger', 'extension']),
  code: z.number().int().nullable(),
  message: z.string().min(1).max(4096),
  data: z.json().nullable()
});

export const relayV2PayloadSchemas = {
  HELLO: z.strictObject({
    managedClaim: z.strictObject({
      instanceRef: z.string().regex(/^ins_[0-9a-f-]{36}$/u),
      generation: PositiveGenerationSchema,
      grantRef: z.string().regex(/^grt_[0-9a-f-]{36}$/u).optional(),
      secret: z.string().regex(/^[A-Za-z0-9_-]{43}$/u).optional()
    }).optional(),
    endpointId: RelayV2EndpointIdentitySchema.optional(),
    publicKeyJwk: JwkSchema,
    pairingCode: RelayV2PairingCodeSchema.optional(),
    proposedNickname: z.string().min(1).max(64),
    extensionVersion: z.string().min(1).max(64),
    browser: BrowserDescriptorSchema,
    supportedProtocolVersions: z.array(z.number().int().positive()).min(1).max(8),
    capabilityManifestIds: z.array(z.string().min(1).max(128)).max(32),
    maxEnvelopeBytes: z.number().int().min(1024).max(16 * 1024 * 1024)
  }).superRefine((value, context) => {
    if (!value.endpointId && !value.pairingCode) {
      context.addIssue({ code: 'custom', path: ['pairingCode'], message: 'An unpaired extension must provide its generated pairing code.' });
    }
  }),
  CHALLENGE: z.strictObject({
    nonce: z.string().min(32).max(1024),
    connectionGeneration: PositiveGenerationSchema,
    selectedProtocolVersion: z.literal(RELAY_PROTOCOL_V2),
    selectedCapabilityManifestId: z.string().min(1).max(128),
    pairingRequired: z.boolean(),
    brokerMaxEnvelopeBytes: z.number().int().min(1024).max(16 * 1024 * 1024)
  }),
  AUTH: z.strictObject({
    endpointId: RelayV2EndpointIdentitySchema,
    signature: z.string().min(32).max(8192),
    connectionGeneration: PositiveGenerationSchema,
    selectedProtocolVersion: z.literal(RELAY_PROTOCOL_V2)
  }),
  PAIRED: z.strictObject({
    endpointId: RelayV2EndpointIdentitySchema,
    nickname: z.string().min(1).max(64),
    connectionGeneration: PositiveGenerationSchema,
    selectedCapabilityManifestId: z.string().min(1).max(128)
  }),
  READY: z.strictObject({
    endpointId: RelayV2EndpointIdentitySchema,
    nickname: z.string().min(1).max(64),
    connectionGeneration: PositiveGenerationSchema,
    selectedCapabilityManifestId: z.string().min(1).max(128),
    brokerVersion: z.string().min(1).max(64),
    requiredExtensionVersion: z.string().min(1).max(64),
    reloadExtension: z.boolean()
  }),
  HEARTBEAT: z.strictObject({
    endpointId: RelayV2EndpointIdentitySchema,
    connectionGeneration: PositiveGenerationSchema,
    inventoryGeneration: GenerationSchema,
    activeAttemptIds: z.array(RelayV2AttemptIdSchema).max(64)
  }),
  INVENTORY_REQUEST: z.strictObject({
    attemptId: RelayV2AttemptIdSchema,
    expectedConnectionGeneration: PositiveGenerationSchema,
    afterInventoryGeneration: GenerationSchema.nullable()
  }),
  INVENTORY_SNAPSHOT: z.strictObject({
    attemptId: RelayV2AttemptIdSchema,
    connectionGeneration: PositiveGenerationSchema,
    inventoryGeneration: GenerationSchema,
    capturedAt: TimestampSchema,
    browser: BrowserDescriptorSchema,
    windows: z.array(RelayV2WindowInventorySchema).max(128)
  }),
  CREATE_TAB: z.strictObject({
    attemptId: RelayV2AttemptIdSchema,
    expected: ExpectedBaseSchema,
    window: RelayV2WindowLocatorSchema,
    group: RelayV2TabGroupLocatorSchema.nullable(),
    url: z.string().max(65_536).nullable(),
    active: z.boolean(),
    index: z.number().int().nonnegative().nullable()
  }),
  GROUP_TABS: z.strictObject({
    attemptId: RelayV2AttemptIdSchema,
    expected: ExpectedBaseSchema,
    window: RelayV2WindowLocatorSchema,
    tabs: z.array(RelayV2TabLocatorSchema).min(1).max(2048),
    group: RelayV2TabGroupLocatorSchema.nullable()
  }),
  MOVE_TAB: z.strictObject({
    attemptId: RelayV2AttemptIdSchema,
    expected: ExpectedTabSchema,
    tab: RelayV2TabLocatorSchema,
    destinationWindow: RelayV2WindowLocatorSchema,
    index: z.number().int().nonnegative()
  }),
  RENAME_GROUP: z.strictObject({
    attemptId: RelayV2AttemptIdSchema,
    expected: ExpectedGroupSchema,
    group: RelayV2TabGroupLocatorSchema,
    title: z.string().max(256)
  }),
  ATTACH_DEBUGGER: z.strictObject({
    attemptId: RelayV2AttemptIdSchema,
    expected: ExpectedAttachmentSchema,
    tab: RelayV2TabLocatorSchema,
    debuggerProtocolVersion: z.string().min(1).max(32)
  }),
  SEND_CDP: z.strictObject({
    attemptId: RelayV2AttemptIdSchema,
    expected: ExpectedAttachmentSchema,
    tab: RelayV2TabLocatorSchema,
    method: z.string().regex(/^[A-Za-z][A-Za-z0-9]*\.[A-Za-z][A-Za-z0-9]*$/),
    params: JsonObjectSchema,
    sessionId: z.string().min(1).max(1024).nullable()
  }),
  DETACH_DEBUGGER: z.strictObject({
    attemptId: RelayV2AttemptIdSchema,
    expected: ExpectedAttachmentSchema,
    tab: RelayV2TabLocatorSchema
  }),
  RECONCILE_ATTEMPT: z.strictObject({
    attemptId: RelayV2AttemptIdSchema,
    reconciledAttemptId: RelayV2AttemptIdSchema,
    expected: z.union([ExpectedBaseSchema, ExpectedAttachmentSchema]),
    window: RelayV2WindowLocatorSchema.optional(),
    tab: RelayV2TabLocatorSchema.optional()
  }).superRefine((value, context) => {
    if ((value.window === undefined) === (value.tab === undefined)) {
      context.addIssue({
        code: 'custom',
        path: ['window'],
        message: 'Attempt reconciliation requires exactly one window or tab identity.'
      });
    }
    if (value.tab !== undefined && !('tabGeneration' in value.expected)) {
      context.addIssue({
        code: 'custom',
        path: ['expected', 'tabGeneration'],
        message: 'Tab attempt reconciliation requires tab generations.'
      });
    }
  }),
  ACK: z.strictObject({
    attemptId: RelayV2AttemptIdSchema,
    operation: OperationTypeSchema,
    expected: z.union([ExpectedBaseSchema, ExpectedTabSchema, ExpectedGroupSchema, ExpectedAttachmentSchema]),
    connectionGeneration: PositiveGenerationSchema,
    acceptedAt: TimestampSchema
  }),
  OPERATION_RESULT: z
    .strictObject({
      attemptId: RelayV2AttemptIdSchema,
      operation: OperationTypeSchema,
      expected: z.union([ExpectedBaseSchema, ExpectedTabSchema, ExpectedGroupSchema, ExpectedAttachmentSchema]),
      observed: ObservedGenerationsSchema,
      outcome: z.enum(['succeeded', 'failed', 'not_found', 'still_running', 'unknown']),
      result: JsonObjectSchema.nullable(),
      error: DebuggerErrorSchema.nullable(),
      completedAt: TimestampSchema
    })
    .superRefine((value, context) => {
      if (value.outcome === 'succeeded' && value.error !== null) {
        context.addIssue({ code: 'custom', path: ['error'], message: 'A succeeded operation cannot carry an error.' });
      }
      if (value.outcome === 'failed' && value.error === null) {
        context.addIssue({ code: 'custom', path: ['error'], message: 'A failed operation must carry an error.' });
      }
    }),
  CDP_EVENT: z.strictObject({
    connectionGeneration: PositiveGenerationSchema,
    inventoryGeneration: GenerationSchema,
    tab: RelayV2TabLocatorSchema,
    attachmentGeneration: PositiveGenerationSchema,
    eventSequence: z.number().int().positive(),
    method: z.string().regex(/^[A-Za-z][A-Za-z0-9]*\.[A-Za-z][A-Za-z0-9]*$/),
    params: JsonObjectSchema,
    sessionId: z.string().min(1).max(1024).nullable(),
    emittedAt: TimestampSchema
  }),
  DEBUGGER_DETACHED: z.strictObject({
    connectionGeneration: PositiveGenerationSchema,
    inventoryGeneration: GenerationSchema,
    tab: RelayV2TabLocatorSchema,
    attachmentGeneration: PositiveGenerationSchema,
    reason: z.string().min(1).max(1024),
    detachedAt: TimestampSchema
  }),
  ERROR: z.strictObject({
    connectionGeneration: PositiveGenerationSchema.nullable(),
    attemptId: RelayV2AttemptIdSchema.nullable(),
    code: z.string().min(1).max(128),
    message: z.string().min(1).max(4096),
    retryable: z.boolean(),
    details: z.json().nullable()
  })
} as const;

export type RelayV2PayloadByType = {
  readonly [Type in RelayV2MessageType]: z.infer<(typeof relayV2PayloadSchemas)[Type]>;
};

export type RelayV2Envelope<Type extends RelayV2MessageType = RelayV2MessageType> =
  Type extends RelayV2MessageType
    ? {
        readonly protocolVersion: typeof RELAY_PROTOCOL_V2;
        readonly messageId: string;
        readonly sentAt: string;
        readonly type: Type;
        readonly payload: RelayV2PayloadByType[Type];
      }
    : never;

const BaseEnvelopeSchema = z.strictObject({
  protocolVersion: z.literal(RELAY_PROTOCOL_V2),
  messageId: UuidSchema,
  sentAt: TimestampSchema,
  type: z.enum(RELAY_V2_MESSAGE_TYPES),
  payload: z.unknown()
});

export class RelayV2EnvelopeTooLargeError extends Error {
  readonly code = 'RELAY_FRAME_TOO_LARGE' as const;

  constructor(readonly actualBytes: number, readonly maximumBytes: number) {
    super(`Relay envelope is ${actualBytes} bytes; the maximum is ${maximumBytes}.`);
    this.name = 'RelayV2EnvelopeTooLargeError';
  }
}

export class RelayProtocolNegotiationError extends Error {
  readonly code = 'RELAY_PROTOCOL_MISMATCH' as const;

  constructor(message: string) {
    super(message);
    this.name = 'RelayProtocolNegotiationError';
  }
}

function measureJsonBytes(value: unknown): number {
  try {
    return new TextEncoder().encode(JSON.stringify(value)).byteLength;
  } catch (error) {
    throw new TypeError(`Relay envelope must be JSON serializable: ${String(error)}`);
  }
}

function assertBoundedEnvelope(value: unknown, maximumBytes = MAX_RELAY_V2_ENVELOPE_BYTES): void {
  const actualBytes = measureJsonBytes(value);
  if (actualBytes > maximumBytes) throw new RelayV2EnvelopeTooLargeError(actualBytes, maximumBytes);
}

export function parseRelayV2Envelope(raw: unknown, maximumBytes = MAX_RELAY_V2_ENVELOPE_BYTES): RelayV2Envelope {
  assertBoundedEnvelope(raw, maximumBytes);
  const base = BaseEnvelopeSchema.parse(raw);
  const payload = relayV2PayloadSchemas[base.type].parse(base.payload);
  return {
    protocolVersion: RELAY_PROTOCOL_V2,
    messageId: base.messageId,
    sentAt: base.sentAt,
    type: base.type,
    payload
  } as RelayV2Envelope;
}

export function createRelayV2Envelope<Type extends RelayV2MessageType>(
  type: Type,
  payload: RelayV2PayloadByType[Type],
  maximumBytes = MAX_RELAY_V2_ENVELOPE_BYTES
): RelayV2Envelope<Type> {
  const envelope = {
    protocolVersion: RELAY_PROTOCOL_V2,
    messageId: crypto.randomUUID(),
    sentAt: new Date().toISOString(),
    type,
    payload: relayV2PayloadSchemas[type].parse(payload) as RelayV2PayloadByType[Type]
  } as unknown as RelayV2Envelope<Type>;
  assertBoundedEnvelope(envelope, maximumBytes);
  return envelope;
}

export function negotiateRelayProtocol(
  peerVersions: readonly number[],
  supportedVersions: readonly number[] = [RELAY_PROTOCOL_V2]
): typeof RELAY_PROTOCOL_V2 {
  if (peerVersions.includes(RELAY_PROTOCOL_V2) && supportedVersions.includes(RELAY_PROTOCOL_V2)) {
    return RELAY_PROTOCOL_V2;
  }
  throw new RelayProtocolNegotiationError(
    `No compatible relay protocol. Peer offered [${peerVersions.join(', ')}]; broker supports [${supportedVersions.join(', ')}].`
  );
}
