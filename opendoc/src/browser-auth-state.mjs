// Original OpenDoc atomic browser-auth state machine. MIT.
// No provider calls or membership I/O may run inside an atomic operation.
export class BrowserAuthStateError extends Error {
  constructor(code = 'DEPENDENCY_UNAVAILABLE') { super(code); this.code = code; }
}
const fail = code => { throw new BrowserAuthStateError(code); };
export const AUTH_STATE_KINDS = Object.freeze(['sessions', 'transactions', 'intents', 'tickets']);
export const emptyAuthState = () => Object.fromEntries(AUTH_STATE_KINDS.map(kind => [kind, new Map()]));
export const copyAuthState = state => Object.fromEntries(AUTH_STATE_KINDS.map(kind => [kind, new Map([...state[kind]].map(([id, value]) => [id, structuredClone(value)]))]));
export function authStatePolicy({ binding, limits }) {
  if (typeof binding !== 'string' || !/^[a-f0-9]{64}$/.test(binding)) throw new TypeError('Explicit browser configuration binding required');
  const keys = ['sessionTtlMs', 'transactionTtlMs', 'ticketTtlMs', 'operationTimeoutMs', 'maxSessions', 'maxTransactions', 'maxTickets', 'maxPendingOperations'];
  const maxima = { sessionTtlMs: 1800000, transactionTtlMs: 300000, ticketTtlMs: 60000, operationTimeoutMs: 10000, maxSessions: 1000, maxTransactions: 1000, maxTickets: 1000, maxPendingOperations: 32 };
  if (!limits || keys.some(key => !Number.isSafeInteger(limits[key]) || limits[key] < 1 || limits[key] > maxima[key])) throw new TypeError('Invalid auth state limits');
  return { binding, limits: Object.fromEntries(keys.map(key => [key, limits[key]])) };
}
export function authStateCounts(state) {
  return { sessions: state.sessions.size, transactions: state.transactions.size, tickets: state.tickets.size, intents: state.intents.size };
}

/** All decisions use values/opaque versions, never JavaScript object identity. */
export function applyAuthState(state, operation, input, { now, limits }) {
  const { sessions, transactions, intents, tickets } = state;
  function removeSession(id, except) {
    sessions.delete(id);
    for (const [key, value] of tickets) if (value.sessionId === id) tickets.delete(key);
    for (const [key, value] of transactions) if (value.priorSessionId === id && key !== except) transactions.delete(key);
    for (const [key, value] of intents) if (value.priorSessionId === id) intents.delete(key);
  }
  for (const [id, value] of sessions) if (value.expiresAt <= now) removeSession(id);
  for (const map of [transactions, intents, tickets]) for (const [id, value] of map) if (value.expiresAt <= now) map.delete(id);
  const liveSession = (id, version) => { const value = sessions.get(id); return value && (!version || value.version === version) ? value : null; };
  const liveTransaction = (id, claimId) => {
    const value = transactions.get(id);
    if (!value || value.claimId !== claimId) return null;
    if (value.priorSessionId && liveSession(value.priorSessionId)?.loginIntent !== value.intentId) { transactions.delete(id); return null; }
    return value;
  };
  const liveIntent = id => {
    const value = intents.get(id);
    if (!value || value.priorSessionId && liveSession(value.priorSessionId)?.loginIntent !== id) return null;
    return value;
  };
  const add = (map, id, value) => { if (map.has(id)) fail('DEPENDENCY_UNAVAILABLE'); map.set(id, value); };
  switch (operation) {
    case 'beginLogin': {
      const prior = liveSession(input.priorSessionId);
      const key = input.oldTransactionId ? `transaction:${input.oldTransactionId}` : input.priorSessionId ? `session:${input.priorSessionId}` : null;
      if (key) for (const [id, value] of intents) if (value.key === key) intents.delete(id);
      if (input.oldTransactionId) transactions.delete(input.oldTransactionId);
      if (prior) {
        prior.loginIntent = input.intentId;
        for (const [id, value] of transactions) if (value.priorSessionId === input.priorSessionId) transactions.delete(id);
        for (const [id, value] of intents) if (value.priorSessionId === input.priorSessionId) intents.delete(id);
      }
      // Initiations consume a durable transaction slot before reading a body.
      if (transactions.size + intents.size >= limits.maxTransactions) fail('CAPACITY_EXCEEDED');
      add(intents, input.intentId, { key, priorSessionId: prior ? input.priorSessionId : null,
        expiresAt: now + limits.operationTimeoutMs });
      return true;
    }
    case 'checkIntent': return !!liveIntent(input.intentId);
    case 'abortLogin': return intents.delete(input.intentId);
    case 'publishLogin': {
      const intent = liveIntent(input.intentId);
      if (!intent) fail('UNAUTHENTICATED');
      add(transactions, input.transactionId, { ...input.transaction, intentId: input.intentId,
        priorSessionId: intent.priorSessionId, expiresAt: now + limits.transactionTtlMs, claimId: null });
      intents.delete(input.intentId);
      return true;
    }
    case 'consumeTransaction': {
      const value = liveTransaction(input.id, null);
      if (!value) return null;
      value.claimId = input.claimId;
      return structuredClone(value);
    }
    case 'checkTransaction': return !!liveTransaction(input.id, input.claimId);
    case 'cancelCallback': {
      if (!liveTransaction(input.id, input.claimId)) return false;
      transactions.delete(input.id); return true;
    }
    case 'finishCallback': {
      if (!liveTransaction(input.id, input.claimId)) fail('UNAUTHENTICATED');
      if (sessions.size - (sessions.has(input.previous) ? 1 : 0) >= limits.maxSessions) fail('CAPACITY_EXCEEDED');
      const expiresAt = Math.min(now + limits.sessionTtlMs, input.tokenExpiresAt);
      if (expiresAt <= now) fail('UNAUTHENTICATED');
      if (input.previous) removeSession(input.previous, input.id);
      add(sessions, input.sessionId, { ...input.session, expiresAt, loginIntent: null });
      transactions.delete(input.id);
      return { expiresAt };
    }
    case 'getSession': return structuredClone(liveSession(input.id));
    case 'checkSession': return !!liveSession(input.id, input.version);
    case 'removeSession': {
      if (!liveSession(input.id, input.version)) return false;
      removeSession(input.id);
      if (input.oldTransactionId) transactions.delete(input.oldTransactionId);
      return true;
    }
    case 'issueTicket': {
      const session = liveSession(input.sessionId, input.version);
      if (!session) fail('UNAUTHENTICATED');
      if (tickets.size >= limits.maxTickets) fail('CAPACITY_EXCEEDED');
      const expiresAt = Math.min(now + limits.ticketTtlMs, session.expiresAt);
      add(tickets, input.ticketId, { sessionId: input.sessionId, roomId: input.roomId, connectionId: null, expiresAt });
      return { expiresAt };
    }
    case 'bindTicket': {
      const value = tickets.get(input.ticketId);
      if (!value || value.roomId !== input.roomId || value.connectionId !== null && value.connectionId !== input.connectionId) return null;
      const session = liveSession(value.sessionId);
      if (!session) return null;
      value.connectionId = input.connectionId;
      return structuredClone({ ticket: value, session });
    }
    case 'checkTicket': {
      const value = tickets.get(input.ticketId);
      return !!(value && value.connectionId === input.connectionId && value.roomId === input.roomId &&
        value.sessionId === input.sessionId && liveSession(input.sessionId, input.version));
    }
    case 'stats': return authStateCounts(state);
    default: fail('DEPENDENCY_UNAVAILABLE');
  }
}

/** Bounded single-process default. Shared only by explicit reuse of this object. */
export class MemoryBrowserAuthState {
  kind = 'memory-browser-auth';
  #state = emptyAuthState();
  #policy;
  configure(options) {
    const policy = authStatePolicy(options);
    if (this.#policy && JSON.stringify(this.#policy) !== JSON.stringify(policy)) throw new TypeError('Auth state configuration mismatch');
    this.#policy = policy;
  }
  run(operation, input = {}, guard = () => {}) {
    guard();
    if (!this.#policy) fail('DEPENDENCY_UNAVAILABLE');
    const next = copyAuthState(this.#state);
    const result = applyAuthState(next, operation, input, { now: Date.now(), limits: this.#policy.limits });
    guard();
    this.#state = next;
    return result;
  }
  clear() { this.#state = emptyAuthState(); }
}
