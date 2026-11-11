// Original OpenDoc implementation. MIT, see ../../LICENSE.
// Binary Yjs v1 updates only. All untrusted decoding runs off the server thread.
import { Worker } from 'node:worker_threads';
import { StoreError } from './memory-store.mjs';

export const MAX_COLLABORATION_UPDATE_BYTES = 64 * 1024;
export const MAX_COLLABORATION_STATE_BYTES = 1024 * 1024;
export const COLLABORATION_LIMITS = Object.freeze({
  maxUpdateBytes: MAX_COLLABORATION_UPDATE_BYTES,
  maxStateBytes: MAX_COLLABORATION_STATE_BYTES,
  maxClients: 128,
  maxStructs: 20000,
  maxClock: 1024 * 1024,
  maxTotalClockLength: 1024 * 1024,
  maxDeleteRanges: 20000,
  maxSharedTypes: 128,
  maxNestedTypes: 1024,
  maxTypeDepth: 64,
  maxValueDepth: 32,
  maxValueNodes: 20000,
  maxPendingBytes: 64 * 1024,
  maxWorkers: 4,
  workerTimeoutMs: 2000,
  workerOldGenerationMb: 64,
  workerYoungGenerationMb: 8,
  workerStackMb: 2
});

let activeWorkers = 0;
const SAFE_CODES = new Set(['BAD_REQUEST', 'TOO_LARGE', 'CAPACITY_EXCEEDED', 'DEPENDENCY_UNAVAILABLE']);

/** Copies bounded bytes before any await, so caller mutation cannot alter a write. */
export function copyCollaborationUpdate(update) {
  if (!(update instanceof Uint8Array) || update.byteLength < 2) throw new StoreError('BAD_REQUEST');
  if (update.byteLength > MAX_COLLABORATION_UPDATE_BYTES) throw new StoreError('TOO_LARGE');
  // Shared memory can change even during copying; do not admit it.
  if (!(update.buffer instanceof ArrayBuffer)) throw new StoreError('BAD_REQUEST');
  return Uint8Array.from(update);
}

/**
 * Merge in a fresh, disposable worker. Resolves {state, changed}. No network,
 * persistence, room creation or dependency loading from user-provided locations.
 * V8 heap limits do NOT bound all native/ArrayBuffer memory. This is a bounded
 * reference service, not a hostile-code sandbox: also set deployment-level CPU,
 * memory, connection/rate and PostgreSQL statement/idle-transaction limits.
 */
export async function mergeCollaborationState(previousState, update) {
  const input = copyCollaborationUpdate(update);
  let previous = null;
  if (previousState !== null) {
    if (!(previousState instanceof Uint8Array) || !(previousState.buffer instanceof ArrayBuffer) ||
        previousState.byteLength < 2 || previousState.byteLength > MAX_COLLABORATION_STATE_BYTES) {
      throw new StoreError('DEPENDENCY_UNAVAILABLE');
    }
    previous = Uint8Array.from(previousState);
  }
  if (activeWorkers >= COLLABORATION_LIMITS.maxWorkers) throw new StoreError('CAPACITY_EXCEEDED');
  activeWorkers++;
  let worker;
  let timer;
  try {
    worker = new Worker(new URL('./collaboration-state-worker.mjs', import.meta.url), {
      workerData: { previous, update: input },
      transferList: [input.buffer, ...(previous ? [previous.buffer] : [])],
      // Never inherit evaluation/preload/debug flags or secrets from the host.
      execArgv: [], env: {}, stdout: true, stderr: true,
      resourceLimits: {
        maxOldGenerationSizeMb: COLLABORATION_LIMITS.workerOldGenerationMb,
        maxYoungGenerationSizeMb: COLLABORATION_LIMITS.workerYoungGenerationMb,
        stackSizeMb: COLLABORATION_LIMITS.workerStackMb
      }
    });
    // Yjs diagnostics must not leak document bytes to application logs.
    worker.stdout.resume();
    worker.stderr.resume();
    return await new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(new StoreError('TOO_LARGE')), COLLABORATION_LIMITS.workerTimeoutMs);
      worker.once('message', result => {
        if (result?.error) return reject(new StoreError(SAFE_CODES.has(result.error) ? result.error : 'DEPENDENCY_UNAVAILABLE'));
        if (!(result?.state instanceof Uint8Array) || result.state.byteLength < 2 ||
            result.state.byteLength > MAX_COLLABORATION_STATE_BYTES || typeof result.changed !== 'boolean') {
          return reject(new StoreError('DEPENDENCY_UNAVAILABLE'));
        }
        resolve({ state: result.state, changed: result.changed });
      });
      worker.once('error', error => reject(new StoreError(error?.code === 'ERR_WORKER_OUT_OF_MEMORY' ? 'TOO_LARGE' : 'DEPENDENCY_UNAVAILABLE')));
      worker.once('exit', () => reject(new StoreError('DEPENDENCY_UNAVAILABLE')));
    });
  } catch (error) {
    throw new StoreError(error instanceof StoreError && SAFE_CODES.has(error.code) ? error.code : 'DEPENDENCY_UNAVAILABLE');
  } finally {
    clearTimeout(timer);
    try { if (worker) await worker.terminate(); } finally { activeWorkers--; }
  }
}
