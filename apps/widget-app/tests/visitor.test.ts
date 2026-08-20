import { beforeEach, describe, expect, it } from 'vitest';
import { getOrCreateVisitorId, getStoredSessionId, storeSessionId } from '../src/lib/visitor.ts';

beforeEach(() => localStorage.clear());

describe('getOrCreateVisitorId', () => {
  it('creates a new id when none is stored', () => {
    expect(getOrCreateVisitorId()).toMatch(/.+/);
  });

  it('returns the same id on every subsequent call', () => {
    const first = getOrCreateVisitorId();
    expect(getOrCreateVisitorId()).toBe(first);
  });

  it('persists across separate calls as a fresh module would see it', () => {
    const first = getOrCreateVisitorId();
    expect(localStorage.getItem('groundwork_visitor_id')).toBe(first);
  });
});

describe('session storage', () => {
  it('has no stored session initially', () => {
    expect(getStoredSessionId()).toBeNull();
  });

  it('returns a stored session id after it is set', () => {
    storeSessionId('sess-123');
    expect(getStoredSessionId()).toBe('sess-123');
  });
});
