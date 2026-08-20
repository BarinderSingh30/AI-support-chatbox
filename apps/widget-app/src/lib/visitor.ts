const VISITOR_KEY = 'groundwork_visitor_id';
const SESSION_KEY = 'groundwork_session_id';

/**
 * A stable anonymous identity for one visitor on one client site, so returning
 * to the same page later can be recognised as the same person without any
 * login. Scoped to the widget iframe's own origin, not the host page's — that
 * is the correct storage partition, since a different client site embedding
 * the same widget should not share a visitor id.
 */
export function getOrCreateVisitorId(): string {
  const existing = localStorage.getItem(VISITOR_KEY);
  if (existing) return existing;
  const id = crypto.randomUUID();
  localStorage.setItem(VISITOR_KEY, id);
  return id;
}

export function getStoredSessionId(): string | null {
  return localStorage.getItem(SESSION_KEY);
}

export function storeSessionId(sessionId: string): void {
  localStorage.setItem(SESSION_KEY, sessionId);
}
