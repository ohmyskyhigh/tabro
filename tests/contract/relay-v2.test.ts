import { describe, expect, it } from 'vitest';
import {
  CONSERVATIVE_CAPABILITY_MANIFEST,
  MAX_RELAY_V2_ENVELOPE_BYTES,
  RELAY_PROTOCOL_V2,
  RELAY_V2_MESSAGE_TYPES,
  CapabilitySelectionError,
  RelayProtocolNegotiationError,
  RelayV2EnvelopeTooLargeError,
  createRelayV2Envelope,
  negotiateRelayProtocol,
  parseRelayV2Envelope,
  relayV2PayloadSchemas,
  selectCapabilityManifest,
  supportsCdpMethod
} from '../../apps/shared/protocol/src/index.js';

const endpointId = 'b3d3d5b8-480b-4dcc-802c-e1412a3f199a';
const attemptId = '6b467585-b09c-43f6-a8ca-14bf9606957c';
const expected = {
  connectionGeneration: 2,
  inventoryGeneration: 7,
  tabGeneration: 4,
  attachmentGeneration: 3
};
const tab = { tabId: 19, tabGeneration: 4, windowId: 5, windowGeneration: 2 };

describe('relay protocol version 2', () => {
  it('publishes the complete transport-neutral message catalog', () => {
    expect(RELAY_PROTOCOL_V2).toBe(2);
    expect(RELAY_V2_MESSAGE_TYPES).toHaveLength(21);
    expect(Object.keys(relayV2PayloadSchemas)).toEqual([...RELAY_V2_MESSAGE_TYPES]);
  });

  it('round-trips pairing negotiation without a public broker reference', () => {
    const envelope = createRelayV2Envelope('HELLO', {
      endpointId,
      publicKeyJwk: { kty: 'EC', crv: 'P-256', x: 'x-value', y: 'y-value' },
      proposedNickname: 'Profile A',
      extensionVersion: '0.2.0',
      browser: { product: 'Chrome', version: '140.0.0.0', userAgent: null },
      supportedProtocolVersions: [2],
      capabilityManifestIds: ['octopus-extension-baseline-v1'],
      maxEnvelopeBytes: MAX_RELAY_V2_ENVELOPE_BYTES
    });

    expect(parseRelayV2Envelope(envelope)).toEqual(envelope);
    expect(JSON.stringify(envelope)).not.toMatch(/workspace_ref|tab_ref|request_ref|session_ref/);
  });

  it('requires an extension-generated readable code only for first registration', () => {
    const firstHello = createRelayV2Envelope('HELLO', {
      publicKeyJwk: { kty: 'EC', crv: 'P-256', x: 'x-value', y: 'y-value' },
      pairingCode: 'MINT-WAVE',
      proposedNickname: 'mintwave',
      extensionVersion: '0.3.0',
      browser: { product: 'Chrome', version: '140.0.0.0', userAgent: null },
      supportedProtocolVersions: [2],
      capabilityManifestIds: ['octopus-extension-baseline-v1'],
      maxEnvelopeBytes: MAX_RELAY_V2_ENVELOPE_BYTES
    });
    expect(parseRelayV2Envelope(firstHello).type).toBe('HELLO');
    expect(() => createRelayV2Envelope('HELLO', {
      publicKeyJwk: { kty: 'EC', crv: 'P-256', x: 'x-value', y: 'y-value' },
      proposedNickname: 'octopus-missing-code',
      extensionVersion: '0.3.0',
      browser: { product: 'Chrome', version: '140.0.0.0', userAgent: null },
      supportedProtocolVersions: [2],
      capabilityManifestIds: ['octopus-extension-baseline-v1'],
      maxEnvelopeBytes: MAX_RELAY_V2_ENVELOPE_BYTES
    })).toThrow();
  });

  it('makes extension version gating explicit in the ready envelope', () => {
    const ready = createRelayV2Envelope('READY', {
      endpointId,
      nickname: 'mintwave',
      connectionGeneration: 2,
      selectedCapabilityManifestId: 'octopus-extension-baseline-v1',
      brokerVersion: '0.4.0',
      requiredExtensionVersion: '0.4.0',
      reloadExtension: true
    });
    expect(parseRelayV2Envelope(ready)).toEqual(ready);
    expect(() => parseRelayV2Envelope({
      ...ready,
      payload: { ...ready.payload, requiredExtensionVersion: undefined }
    })).toThrow();
  });

  it('requires every CDP mutation to carry expected private generations', () => {
    const envelope = createRelayV2Envelope('SEND_CDP', {
      attemptId,
      expected,
      tab,
      method: 'Runtime.evaluate',
      params: { expression: 'document.title' },
      sessionId: null
    });
    expect(parseRelayV2Envelope(envelope).type).toBe('SEND_CDP');

    const missingExpected = { ...envelope, payload: { ...envelope.payload, expected: undefined } };
    expect(() => parseRelayV2Envelope(missingExpected)).toThrow();
  });

  it('rejects public references and raw public-routing fields on private relay messages', () => {
    const envelope = createRelayV2Envelope('SEND_CDP', {
      attemptId,
      expected,
      tab,
      method: 'Page.navigate',
      params: { url: 'https://example.com' },
      sessionId: null
    });
    expect(() =>
      parseRelayV2Envelope({
        ...envelope,
        payload: { ...envelope.payload, workspace_ref: 'workspace-ref', tab_ref: 'tab-ref', request_ref: 'request-ref' }
      })
    ).toThrow();
  });

  it('round-trips inventory, operation results, CDP events, and detach facts', () => {
    const inventory = createRelayV2Envelope('INVENTORY_SNAPSHOT', {
      attemptId,
      connectionGeneration: 2,
      inventoryGeneration: 7,
      capturedAt: '2026-08-31T00:00:00.000Z',
      browser: { product: 'Chrome', version: '140.0.0.0', userAgent: null },
      windows: [
        {
          windowId: 5,
          windowGeneration: 2,
          focused: true,
          incognito: false,
          type: 'normal',
          state: 'normal',
          groups: [],
          tabs: [
            {
              tabId: 19,
              tabGeneration: 4,
              windowId: 5,
              groupId: null,
              openerTabId: null,
              active: true,
              pinned: false,
              discarded: false,
              status: 'complete',
              url: 'https://example.com',
              title: 'Example Domain',
              debugger: { attached: true, attachmentGeneration: 3, protocolVersion: '1.3' }
            }
          ]
        }
      ]
    });
    expect(parseRelayV2Envelope(inventory).type).toBe('INVENTORY_SNAPSHOT');

    const result = createRelayV2Envelope('OPERATION_RESULT', {
      attemptId,
      operation: 'SEND_CDP',
      expected,
      observed: {
        connectionGeneration: 2,
        inventoryGeneration: 7,
        tabGeneration: 4,
        groupGeneration: null,
        attachmentGeneration: 3
      },
      outcome: 'succeeded',
      result: { result: { type: 'string', value: 'Example Domain' } },
      error: null,
      completedAt: '2026-08-31T00:00:01.000Z'
    });
    expect(parseRelayV2Envelope(result).type).toBe('OPERATION_RESULT');

    const event = createRelayV2Envelope('CDP_EVENT', {
      connectionGeneration: 2,
      inventoryGeneration: 7,
      tab,
      attachmentGeneration: 3,
      eventSequence: 1,
      method: 'Page.loadEventFired',
      params: { timestamp: 123.45 },
      sessionId: null,
      emittedAt: '2026-08-31T00:00:01.000Z'
    });
    expect(parseRelayV2Envelope(event).type).toBe('CDP_EVENT');

    const detached = createRelayV2Envelope('DEBUGGER_DETACHED', {
      connectionGeneration: 2,
      inventoryGeneration: 8,
      tab,
      attachmentGeneration: 3,
      reason: 'canceled_by_user',
      detachedAt: '2026-08-31T00:00:02.000Z'
    });
    expect(parseRelayV2Envelope(detached).type).toBe('DEBUGGER_DETACHED');
  });

  it('rejects invalid result/error relationships and oversized frames', () => {
    expect(() =>
      createRelayV2Envelope('OPERATION_RESULT', {
        attemptId,
        operation: 'CREATE_TAB',
        expected: { connectionGeneration: 2, inventoryGeneration: 7 },
        observed: {
          connectionGeneration: 2,
          inventoryGeneration: 8,
          tabGeneration: null,
          groupGeneration: null,
          attachmentGeneration: null
        },
        outcome: 'failed',
        result: null,
        error: null,
        completedAt: '2026-08-31T00:00:01.000Z'
      })
    ).toThrow();

    expect(() =>
      createRelayV2Envelope(
        'ERROR',
        {
          connectionGeneration: null,
          attemptId: null,
          code: 'TEST',
          message: 'x'.repeat(4096),
          retryable: false,
          details: null
        },
        128
      )
    ).toThrow(RelayV2EnvelopeTooLargeError);
  });

  it('negotiates only relay v2 and rejects an unknown-only peer', () => {
    expect(negotiateRelayProtocol([1, 2])).toBe(2);
    expect(() => negotiateRelayProtocol([1, 3])).toThrow(RelayProtocolNegotiationError);
  });
});

describe('conservative extension capability manifest', () => {
  const unknownFacts = {
    relayProtocolVersion: 2,
    extensionVersion: '99.0.0-unknown',
    browserProduct: 'Chrome/999',
    browserMajor: 999,
    advertisedManifestIds: []
  } as const;

  it('supports a reviewed managed-tab automation baseline and excludes browser-wide CDP', () => {
    expect(CONSERVATIVE_CAPABILITY_MANIFEST.profile).toBe('conservative');
    expect(supportsCdpMethod(CONSERVATIVE_CAPABILITY_MANIFEST, 'Runtime.evaluate')).toBe(true);
    expect(supportsCdpMethod(CONSERVATIVE_CAPABILITY_MANIFEST, 'Input.dispatchMouseEvent')).toBe(true);
    expect(supportsCdpMethod(CONSERVATIVE_CAPABILITY_MANIFEST, 'DOM.setFileInputFiles')).toBe(true);
    expect(supportsCdpMethod(CONSERVATIVE_CAPABILITY_MANIFEST, 'DOM.setFileInputFiles', true)).toBe(false);
    expect(supportsCdpMethod(CONSERVATIVE_CAPABILITY_MANIFEST, 'Browser.close')).toBe(false);
    expect(supportsCdpMethod(CONSERVATIVE_CAPABILITY_MANIFEST, 'Target.createTarget')).toBe(false);
  });

  it('uses the conservative profile for unknown versions or rejects when required', () => {
    expect(selectCapabilityManifest(unknownFacts)).toMatchObject({ basis: 'conservative_fallback' });
    expect(() => selectCapabilityManifest(unknownFacts, [], 'reject')).toThrow(CapabilitySelectionError);
  });
});
