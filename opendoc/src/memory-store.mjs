// Original OpenDoc reference implementation. MIT, see ../../LICENSE.
export class StoreError extends Error {
  constructor(code) { super(code); this.code = code; }
}

/** Volatile, single-process reference store. Never use this for durable data. */
export class MemoryDocumentStore {
  kind = 'volatile-memory';
  #tenants = new Map();
  #bytes = 0;
  #count = 0;
  #limits;

  constructor({ maxDocumentsPerTenant = 100, maxDocuments = 1000, maxBytes = 16 * 1024 * 1024 } = {}) {
    if (![maxDocumentsPerTenant, maxDocuments, maxBytes].every(n => Number.isSafeInteger(n) && n > 0)) throw new TypeError('Positive integer limits required');
    this.#limits = { maxDocumentsPerTenant, maxDocuments, maxBytes };
  }

  list(tenantId) {
    return [...(this.#tenants.get(tenantId)?.values() ?? [])].map(({ content, ...metadata }) => ({ ...metadata }));
  }
  get(tenantId, id) {
    const doc = this.#tenants.get(tenantId)?.get(id);
    return doc ? { ...doc } : null;
  }
  create(tenantId, input) {
    const tenant = this.#tenants.get(tenantId) ?? new Map();
    if (tenant.has(input.id)) throw new StoreError('CONFLICT');
    const bytes = this.#size(input);
    if (tenant.size >= this.#limits.maxDocumentsPerTenant || this.#count >= this.#limits.maxDocuments || this.#bytes + bytes > this.#limits.maxBytes) throw new StoreError('CAPACITY_EXCEEDED');
    const now = new Date().toISOString();
    const doc = { id: input.id, title: input.title, content: input.content, revision: 1, createdAt: now, updatedAt: now };
    tenant.set(doc.id, doc);
    this.#tenants.set(tenantId, tenant);
    this.#bytes += bytes;
    this.#count++;
    return { ...doc };
  }
  replace(tenantId, id, expectedRevision, input) {
    const tenant = this.#tenants.get(tenantId);
    const current = tenant?.get(id);
    if (!current) throw new StoreError('NOT_FOUND');
    if (current.revision !== expectedRevision) throw new StoreError('PRECONDITION_FAILED');
    const bytes = this.#bytes - this.#size(current) + this.#size({ ...input, id });
    if (bytes > this.#limits.maxBytes) throw new StoreError('CAPACITY_EXCEEDED');
    if (!Number.isSafeInteger(current.revision + 1)) throw new StoreError('CAPACITY_EXCEEDED');
    // No await between comparison and mutation: atomic within this one JS process.
    const doc = { ...current, title: input.title, content: input.content, revision: current.revision + 1, updatedAt: new Date().toISOString() };
    tenant.set(id, doc);
    this.#bytes = bytes;
    return { ...doc };
  }
  #size(input) { return new TextEncoder().encode(input.id + input.title + input.content).byteLength; }
}
