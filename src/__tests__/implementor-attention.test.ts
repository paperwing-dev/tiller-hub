import { describe, expect, it, vi } from 'vitest';
import type { StoredSession } from '../../api/types';
import {
  acknowledgeImplementorAttentionAndRecover,
  resolveVisibleImplementorAttentionTarget,
} from '../implementor-attention';

function makeSession(overrides: Partial<StoredSession> = {}): StoredSession {
  return {
    id: 'lead-session',
    tag: 'demo-env',
    machine_id: null,
    metadata: JSON.stringify({ envSlug: 'demo-env', role: 'lead' }),
    agent_state: '{}',
    todos: '[]',
    allowed_tools: '[]',
    active: 1,
    metadata_version: 1,
    agent_state_version: 1,
    todos_version: 1,
    seq: 1,
    ended_at: null,
    created_at: '2026-08-12T00:00:00.000Z',
    updated_at: '2026-08-12T00:00:00.000Z',
    ...overrides,
  };
}

const envs = [
  { slug: 'demo-env', implementorAttentionToken: 'token-1' },
  { slug: 'other-env', implementorAttentionToken: 'token-other' },
];
const sessions = [
  makeSession(),
  makeSession({
    id: 'worker-session',
    metadata: JSON.stringify({ envSlug: 'demo-env', role: 'worker' }),
  }),
  makeSession({
    id: 'other-lead',
    tag: 'other-env',
    metadata: JSON.stringify({ envSlug: 'other-env', role: 'lead' }),
  }),
];

describe('visible implementor attention acknowledgement', () => {
  it('targets the exact environment page, its Ship view, and its current lead session', () => {
    expect(resolveVisibleImplementorAttentionTarget({
      visible: true,
      pathname: '/envs/demo-env',
      envs,
      sessions,
    })).toEqual({ slug: 'demo-env', token: 'token-1' });
    expect(resolveVisibleImplementorAttentionTarget({
      visible: true,
      pathname: '/envs/demo-env/ship',
      envs,
      sessions,
    })).toEqual({ slug: 'demo-env', token: 'token-1' });
    expect(resolveVisibleImplementorAttentionTarget({
      visible: true,
      pathname: '/envs/demo-env/changes',
      envs,
      sessions,
    })).toEqual({ slug: 'demo-env', token: 'token-1' });
    expect(resolveVisibleImplementorAttentionTarget({
      visible: true,
      pathname: '/sessions/lead-session',
      envs,
      sessions,
    })).toEqual({ slug: 'demo-env', token: 'token-1' });
  });

  it.each([
    ['a hidden environment page', false, '/envs/demo-env'],
    ['a child session', true, '/sessions/worker-session'],
    ['an unrelated route', true, '/projects/repo-1'],
  ])('does not target %s', (_label, visible, pathname) => {
    expect(resolveVisibleImplementorAttentionTarget({
      visible,
      pathname,
      envs,
      sessions,
    })).toBeNull();
  });

  it('targets a token as soon as it arrives on an already-open environment', () => {
    const options = {
      visible: true,
      pathname: '/envs/demo-env',
      sessions,
    };
    expect(resolveVisibleImplementorAttentionTarget({
      ...options,
      envs: [{ slug: 'demo-env', implementorAttentionToken: null }],
    })).toBeNull();
    expect(resolveVisibleImplementorAttentionTarget({ ...options, envs }))
      .toEqual({ slug: 'demo-env', token: 'token-1' });
  });

  it.each(['acknowledged', 'conflict'] as const)(
    'recovers the affected environment after %s',
    async (result) => {
      const acknowledge = vi.fn().mockResolvedValue(result);
      const recoverEnv = vi.fn();

      await expect(acknowledgeImplementorAttentionAndRecover(
        { slug: 'demo-env', token: 'token-1' },
        acknowledge,
        recoverEnv,
      )).resolves.toBe(result);
      expect(acknowledge).toHaveBeenCalledWith('demo-env', 'token-1');
      expect(recoverEnv).toHaveBeenCalledWith('demo-env');
    },
  );

  it('retries a transient acknowledgement failure without a route or visibility change', async () => {
    const acknowledge = vi.fn()
      .mockRejectedValueOnce(new Error('temporary network failure'))
      .mockResolvedValueOnce('acknowledged');
    const recoverEnv = vi.fn();
    const onRetry = vi.fn();

    await expect(acknowledgeImplementorAttentionAndRecover(
      { slug: 'demo-env', token: 'token-1' },
      acknowledge,
      recoverEnv,
      { retryDelaysMs: [0], onRetry },
    )).resolves.toBe('acknowledged');
    expect(acknowledge).toHaveBeenCalledTimes(2);
    expect(onRetry).toHaveBeenCalledOnce();
    expect(recoverEnv).toHaveBeenCalledOnce();
  });
});
