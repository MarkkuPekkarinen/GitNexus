/**
 * BindingAccumulator — read-append-only accumulator that collects TypeEnv
 * bindings across all files in the GitNexus analyzer pipeline.
 */

export interface BindingEntry {
  readonly scope: string; // '' for file-level, 'funcName@startIndex' for function-local
  readonly varName: string;
  readonly typeName: string;
}

const ENTRY_OVERHEAD = 64; // bytes per entry (object overhead + property refs)
const MAP_ENTRY_OVERHEAD = 80; // bytes per file entry in the map

export class BindingAccumulator {
  private readonly _map = new Map<string, BindingEntry[]>();
  private _totalBindings = 0;
  private _finalized = false;

  /**
   * Append bindings for a file. Safe to call multiple times for the same file.
   * Throws if the accumulator has been finalized. Skips if entries is empty.
   */
  appendFile(filePath: string, entries: BindingEntry[]): void {
    if (this._finalized) {
      throw new Error('BindingAccumulator is finalized — no further appends allowed');
    }
    if (entries.length === 0) {
      return;
    }
    const existing = this._map.get(filePath);
    if (existing !== undefined) {
      for (const e of entries) {
        existing.push(e);
      }
    } else {
      this._map.set(filePath, entries.slice());
    }
    this._totalBindings += entries.length;
  }

  /** Lock the accumulator — no further appends. Idempotent. */
  finalize(): void {
    this._finalized = true;
  }

  /** Get all bindings for a file, or undefined if the file is unknown. */
  getFile(filePath: string): readonly BindingEntry[] | undefined {
    return this._map.get(filePath);
  }

  /**
   * Get only scope='' (file-level) entries as [varName, typeName] tuples.
   * Backward-compatible with the old workerTypeEnvBindings pattern.
   * Returns an empty array for an unknown file.
   */
  fileScopeEntries(filePath: string): [string, string][] {
    const entries = this._map.get(filePath);
    if (entries === undefined) {
      return [];
    }
    const result: [string, string][] = [];
    for (const e of entries) {
      if (e.scope === '') {
        result.push([e.varName, e.typeName]);
      }
    }
    return result;
  }

  /** Iterate over all file paths in insertion order. */
  files(): IterableIterator<string> {
    return this._map.keys();
  }

  /** Number of distinct files with at least one binding. */
  get fileCount(): number {
    return this._map.size;
  }

  /** Total number of binding entries across all files. */
  get totalBindings(): number {
    return this._totalBindings;
  }

  /** Whether the accumulator has been finalized. */
  get finalized(): boolean {
    return this._finalized;
  }

  /**
   * Rough memory estimate in bytes (intentionally pessimistic).
   * Formula: sum of (ENTRY_OVERHEAD + char bytes of scope+varName+typeName) per entry
   *          + MAP_ENTRY_OVERHEAD + char bytes of filePath per file.
   *
   * Note: V8 stores all-ASCII strings as Latin-1 (1 byte/char) and only upgrades
   * to UCS-2 (2 bytes/char) for non-Latin-1 code points. Source paths and type names
   * are typically all-ASCII, so actual heap cost is roughly half what this returns.
   * The pessimistic factor is intentional — better to over-budget than under-budget.
   */
  estimateMemoryBytes(): number {
    let total = 0;
    for (const [filePath, entries] of this._map) {
      total += MAP_ENTRY_OVERHEAD + filePath.length * 2;
      for (const e of entries) {
        total += ENTRY_OVERHEAD + (e.scope.length + e.varName.length + e.typeName.length) * 2;
      }
    }
    return total;
  }
}
