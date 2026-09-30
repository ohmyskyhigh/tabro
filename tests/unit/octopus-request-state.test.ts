import { describe, expect, it } from 'vitest';
import { DeterministicReferenceFactory } from '../../apps/broker/src/core/octopus/reference-factory.js';
import { updateRequestProgress } from '../../apps/broker/src/core/octopus/request-state-machine.js';
import { TabLane } from '../../apps/broker/src/core/octopus/tab-lane.js';

describe('Tabro request primitives', () => {
  it('issues opaque typed references without routing data', () => {
    const factory = new DeterministicReferenceFactory();
    expect(factory.issue('workspace')).toBe('wrk_test_000001');
    expect(factory.issue('tab')).toBe('tab_test_000002');
  });

  it('keeps pause separate from lifecycle and clears it at terminal state', () => {
    const paused = updateRequestProgress({
      state: 'queued', phase: 'accepted', pauseCondition: null,
      checkpointName: 'accepted', checkpointDetails: {}
    }, { pauseCondition: 'extension_disconnected', phase: 'waiting_for_endpoint' });
    expect(paused.state).toBe('queued');
    expect(paused.pauseCondition).toBe('extension_disconnected');
    expect(() => updateRequestProgress(paused, { state: 'failed' })).toThrow('cannot retain a pause');
    expect(updateRequestProgress(paused, { state: 'failed', pauseCondition: null }).state).toBe('failed');
  });

  it('keeps an earlier acknowledgement barrier ahead of later work', () => {
    const lane = new TabLane();
    lane.accept('req_a');
    lane.accept('req_b');
    lane.acknowledge('req_b', true);
    expect(lane.claimHead()).toBeNull();
    lane.acknowledge('req_a', true);
    expect(lane.claimHead()?.requestRef).toBe('req_a');
    lane.terminalize('req_a', 'succeeded');
    expect(lane.claimHead()?.requestRef).toBe('req_b');
  });

  it('skips a position only after acknowledgement delivery failed', () => {
    const lane = new TabLane();
    lane.accept('req_a');
    lane.accept('req_b');
    lane.acknowledge('req_b', true);
    lane.acknowledge('req_a', false);
    expect(lane.claimHead()?.requestRef).toBe('req_b');
  });
});
