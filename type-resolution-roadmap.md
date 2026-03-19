# Type Resolution Roadmap

This roadmap describes the evolution of GitNexus's type-resolution layer from a receiver-disambiguation aid into a production-grade static-analysis foundation.

---

## Principles

- **stay conservative** — prefer missing a binding over introducing a misleading one
- **prefer explainable inference over clever but brittle inference**
- **limit performance overhead during ingestion**
- **keep per-language extractors explicit rather than over-generic**
- **separate "better receiver resolution" from "compiler-grade typing"**

The goal is not to build a compiler. The goal is to support high-value static analysis for call graphs, impact analysis, context gathering, and downstream graph features.

---

## Delivered Phases

### Phase 7: Cross-Scope and Return-Aware Propagation ✅

**Shipped in** `feat/phase7-type-resolution`.

- `ReturnTypeLookup` interface threading return-type knowledge into TypeEnv
- Iterable call-expression support across 7 languages (Go, TS, Python, Rust, Java, Kotlin, C#)
- PHP class-level `@var` property typing for `$this->property` foreach (Strategy C)
- `pendingCallResults` infrastructure (Tier 2b loop + `PendingAssignment` union) — activated by Phase 9

### Phase 8: Field and Property Type Resolution ✅

**Shipped in** `feat/phase8-field-property-type-resolution`.

- SymbolTable `fieldByOwner` index — O(1) field lookup by `ownerNodeId\0fieldName`
- `HAS_PROPERTY` edge type + `declaredType` on Property symbols
- Deep chain resolution up to 3 levels (`user.address.city.getName()`) across 10 languages
- Mixed field+method chains via unified `MixedChainStep[]` (`svc.getUser().address.save()`)
- Type-preserving stdlib passthroughs (`unwrap`, `clone`, `expect`, etc.)
- `ACCESSES` edge type — read/write field access tracking across 12 languages
- C++ `field_declaration` capture, `field_expression` receiver support
- Rust unit struct instantiation, Ruby YARD `@return` for `attr_accessor`

### Phase 9 + 9C: Return-Type-Aware Variable Binding ✅

**Shipped in** `feat/phase9-call-result-binding` (PR #379).

- Simple call-result binding: `const user = getUser(); user.save()` across 11 languages
- Unified fixpoint loop replacing sequential Tier 2b/2a — handles 4 binding kinds (`callResult`, `copy`, `fieldAccess`, `methodCallResult`) at arbitrary depth
- Field access binding: `const addr = user.address` resolves via `lookupFieldByOwner` + `declaredType`
- Method-call-result binding: `const city = addr.getCity()` resolves via `lookupFuzzyCallable` filtered by `ownerId`
- Fixpoint iterates until stable (max 10 iterations), enabling chains like `getUser() → .address → .getCity() → city.save()`
- Reverse-order copy chains now resolve (`const b = a; const a: User = x` → both resolve)

---

## Open Phases

### Phase 10: Loop-Fixpoint Bridge

**Supersedes Phase 9B.** For-loop element bindings run during `walk()` before the fixpoint. Variables typed by the fixpoint are invisible to for-loop extraction.

**Problem:**
```typescript
const users = getUsers();       // fixpoint: users → User[]
for (const u of users) {        // walk-time: users untyped → u unresolved
  u.save();                     // missed CALLS edge
}
```

**Approach:** Post-fixpoint for-loop replay. During `walk()`, store for-loop AST nodes whose iterable is unresolved. After fixpoint completes, replay `extractForLoopBinding` on those nodes using the now-resolved iterable types.

**Scope:**
- Infrastructure: `pendingForLoops` collection + replay (~20 lines in `type-env.ts`)
- No extractor changes — reuses existing `extractForLoopBinding`
- Swift: add for-loop element binding (currently missing)
- Nested for-loops with field-dependent iterables are NOT replayed (handled by call-processor chain resolution)

**Risks:** AST node lifetime (safe — nodes valid within `buildTypeEnv` lifetime).

**Impact: High | Effort: Low-Medium**

---

### Phase 11: Inheritance & this/self

Four items sharing infrastructure.

#### 11A: MRO-aware field and method lookups

**Problem:** `lookupFieldByOwner` only finds direct fields. Inherited fields (`Admin extends User`, field on `User`) don't resolve.

**Approach:** Pre-compute `parentMap: Map<nodeId, nodeId[]>` from EXTENDS + IMPLEMENTS edges. Pass to `buildTypeEnv`. Update `resolveFieldType` and `resolveMethodReturnType` to walk parent chain on miss (max depth 5, cycle-safe, first-match-wins for diamond inheritance).

Includes IMPLEMENTS edges so interface-declared fields/methods resolve (Java, Kotlin, C#).

#### 11B: this/self in fixpoint

**Problem:** `this.field` and `this.method()` emit pending items with `receiver: 'this'`, but `scopeEnv.get('this')` returns `undefined`.

**Approach:** At collection time during `walk()`, resolve the enclosing class name immediately via `findEnclosingClassName()` and substitute it as the receiver. Covers both `fieldAccess` and `methodCallResult`. No fixpoint changes needed. 5-10 lines per extractor.

#### 11C: Go inc/dec write access

**Problem:** `obj.field++`/`obj.field--` produce `inc_statement`/`dec_statement` — write-access tracking doesn't see them.

**Approach:** Add these node types to call-processor write detection (~5 lines).

#### 11D: Swift assignment chains

**Problem:** Swift has no `extractPendingAssignment` — copy/callResult/fieldAccess/methodCallResult don't work.

**Approach:** Implement `extractPendingAssignment` for Swift covering all 4 binding kinds.

**Risks:** Performance of parent chain walking in fixpoint (bounded by `n_pending × depth × iterations`). Interface method ambiguity (mitigated by checking direct class first, parents on miss).

**Impact: Medium-High | Effort: Medium**

---

### Phase 12: Destructuring

**Problem:** `const { address, name } = user` produces no bindings — LHS is a pattern node, not an identifier.

**Approach:** Add `{ kind: 'destructure', source, bindings: [{ varName, fieldName }] }` to `PendingAssignment`. In the fixpoint, when source's type resolves, look up each field via `lookupFieldByOwner` and bind each variable.

Works without Phase 11A (direct fields only). Phase 11A MRO enhances it to resolve inherited fields too.

**Phased delivery:**

| Sub-phase | Scope | Languages |
|-----------|-------|-----------|
| **12A** | Object destructuring | TS/JS (`object_pattern`) |
| **12B** | Struct pattern destructuring | Rust (`struct_pattern`) |
| **12C** (deferred) | Positional destructuring | Python, Kotlin, C#, C++ — needs tuple-position-to-field mapping |

Skip: computed properties, rest elements, nested destructuring (`{ address: { city } }` — deferred).

**Risks:** Nested destructuring requires recursive resolution (explicitly deferred).

**Impact: Medium | Effort: Medium**

---

### Phase 13: Branch-Sensitive Narrowing

**Design principle:** Targeted narrowing, not general control-flow analysis. Skip anything that requires a control-flow graph.

**Phased delivery:**

#### 13A: Type predicate functions (TS only)

`function isUser(x: unknown): x is User` — detect `type_predicate` return type. When called in an `if` condition, emit pattern binding for the narrowed parameter.

#### 13B: Nullability narrowing (TS/Kotlin/C#/Swift)

`if (x != null)` → strip nullable wrapper in truthy branch. Uses existing `patternOverrides` mechanism (position-indexed, scope-aware). Swift `guard let` uses standard scopeEnv (narrowing persists for rest of function). Swift work requires Phase 11D (assignment chains) first.

#### 13C: Discriminated union narrowing (deferred)

`if (shape.kind === 'circle')` → needs tagged union metadata not in SymbolTable. Defer.

**What we skip entirely:** Full control-flow graph, arbitrary conditional narrowing, `typeof` guards, exhaustiveness checking.

**Risks:** Scope leakage (mitigated by `patternOverrides` position indexing). Swift `guard let` needs scopeEnv path (different from `patternOverrides`).

**Impact: Medium | Effort: Medium-High**

---

### Phase 14: Cross-File Binding Propagation

**Problem:** `buildTypeEnv` is per-file. Inferred types don't cross file boundaries.

```typescript
// file-a.ts — fixpoint resolves: config → Config
export const config = getConfig();

// file-b.ts — config has no type
import { config } from './file-a';
config.validate();  // missed
```

**Approach: Export-type index.** After each file's fixpoint, export resolved bindings for exported symbols into `ExportedBindings: Map<filePath, Map<symbolName, typeName>>`. Subsequent files seed scopeEnv from this index for imported symbols.

**Details:**
- Process files in topological import order (import-processor already builds the dependency graph)
- Re-exports: follow import chain transitively in `ExportedBindings`
- Barrel files (`index.ts`): chain of re-exports — same mechanism
- Default exports: keyed as `"default"` in the map, mapped to local name at import site
- Dynamic imports (`import()`, conditional `require()`): excluded — runtime-only edges
- Circular imports: files in a cycle processed in arbitrary order within the cycle; cross-cycle bindings don't propagate (conservative)
- Parallelism preserved within topological levels

**Why this is last:** Every earlier phase makes the per-file fixpoint stronger, reducing cases where cross-file propagation is needed. This is also the highest-risk architectural change.

**Risks:** Topological ordering correctness (mitigated by reusing import-processor's existing graph). Re-export chain depth (bounded by import depth, typically 2-3). Memory for `ExportedBindings` (~100K entries for 10K-file monorepo — negligible).

**Impact: High | Effort: High**

---

## Dependency Graph

```
Phase 10 (loops) ──────────────────────┐
                                       │
Phase 11 (MRO + this + Go + Swift) ───┤
                                       ├──→ Phase 14 (cross-file)
Phase 12 (destructuring) ─────────────┤
                                       │
Phase 13 (branch narrowing) ───────────┘

Phases 10–13 are independent of each other.
  Exception: Phase 13B Swift (guard let) requires Phase 11D (Swift assignment chains).
  Exception: Phase 12 benefits from Phase 11A (MRO) but works without it.
Phase 14 depends on all of 10–13 being stable.
Swift parity threaded through Phases 10–13 incrementally.
```

---

## Language-Specific Gaps (remaining)

### Swift
- For-loop element binding → Phase 10
- Assignment chains (copy, callResult, fieldAccess, methodCallResult) → Phase 11D
- Pattern binding → Phase 13B (`guard let`)

### Go
- `obj.field++`/`obj.field--` write ACCESSES → Phase 11C

### Rust
- Struct-pattern field destructuring → Phase 12B

### All languages
- Inherited field/method resolution → Phase 11A
- `this`/`self` in fixpoint → Phase 11B
- Cross-file binding propagation → Phase 14

---

## Milestones

### Milestone A — Inference Expansion ✅ (Phase 7)

Loop inference, `ReturnTypeLookup`, PHP Strategy C.

### Milestone B — Structural Member Typing ✅ (Phase 8)

Field/property maps, deep chains, mixed chains, stdlib passthroughs.

### Milestone C — Static-Analysis Foundation ✅ (Phase 9 + 9C)

Unified fixpoint loop, call-result binding, field access binding, method-call-result binding, arbitrary-depth chain propagation.

### Milestone D — Completeness ← **next** (Phases 10–13)

Loop-fixpoint bridge, inheritance walking, `this`/`self` resolution, destructuring, branch narrowing, Swift parity.

### Milestone E — Cross-Boundary (Phase 14)

Export-type index, cross-file binding propagation.

---

## Open Design Questions

| # | Question | Status |
|---|----------|--------|
| 1 | Where should field-type metadata live? | ✅ Resolved: `fieldByOwner` index in SymbolTable |
| 2 | How should ambiguity be represented? | ✅ Resolved: keep `undefined`. Conservative approach proven through 9 phases. |
| 3 | How much receiver context for return types? | ✅ Resolved: Phase 9C `resolveMethodReturnType` filters by `ownerId`. |
| 4 | How much branch sensitivity? | ✅ Resolved: type predicates + null checks only. No control-flow graph. (Phase 13) |
| 5 | Field typing and chain typing — one phase or two? | ✅ Resolved: incremental delivery within phases (Phase 8/8A precedent). |
| 6 | Phase 9B vs Phase 10? | ✅ Resolved: Phase 10 supersedes 9B via post-fixpoint replay. |

---

## What "Production-Grade" Means Here

For GitNexus, production-grade does **not** mean replacing a language compiler. The target:

- Strong receiver-constrained call resolution across common language idioms
- Reliable handling of typed loops, constructors, and common patterns
- Return-type propagation for service/repository code
- Field/property knowledge for chained-member analysis
- Inheritance-aware lookups
- Conservative behavior under ambiguity
- Predictable performance during indexing

That supports: better call graphs, more accurate impact analysis, stronger AI context assembly, more trustworthy graph traversal.

---

## Summary

**Complete:** Phases 7, 8, 9, 9C — explicit types, constructor inference, loop inference, field/property resolution, deep chains, mixed chains, stdlib passthroughs, comment-based types, unified fixpoint with 4 binding kinds, arbitrary-depth chain propagation across 11 languages.

**Next:** Phase 10 (loop-fixpoint bridge) → Phase 11 (MRO + this/self + Go + Swift) → Phase 12 (destructuring) → Phase 13 (branch narrowing) → Phase 14 (cross-file propagation).

Each phase is independently deliverable (except Phase 14 which depends on 10–13 being stable). Swift parity is threaded incrementally through Phases 10–13.
