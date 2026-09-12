# Siddhartha V2 Phase 1 Summary

Phase 1 changes only the legacy suspect semantics. The fixed raw fixture and the per-chapter normalize/verify pipeline are unchanged.

## Change

Before:

`relation.status == pending -> MissingEvidence suspect -> Final Reconcile`

After:

`pending -> review state in ledger`

A relation becomes `MissingEvidence` only when deterministic evidence localization actually failed: the quote is empty, the quote was not found, or it cannot be reduced to one concrete `start/end` span. Rejected relations do not create evidence-repair cases.

## Fixed-fixture A/B

Fixture SHA-256: `a396117ec1971838a5d00e5c9ff7f6b708b6b12cc7975e42da46531836ba80d4`

Comparison uses P0 Run 3 because it includes the same characters/cases telemetry used by the Phase 1 run.

| Metric | P0 Run 3 | Phase 1 Run 1 | Change |
|---|---:|---:|---:|
| Evaluator score | 77.72 | 77.72 | 0 |
| Reconcile suspects | 29 | 3 | -89.7% |
| Missing-evidence suspects | 28 | 2 | -92.9% |
| Cast conflicts | 1 | 1 | unchanged |
| Relation conflicts | 0 | 0 | unchanged |
| Total LLM requests | 34 | 34 | unchanged |
| Total message chars | 374,070 | 263,621 | -29.5% |
| Total input tokens | 211,361 | 162,749 | -23.0% |
| Total tokens | 221,022 | 172,251 | -22.1% |
| Reconcile requests | 12 | 12 | unchanged |
| Reconcile message chars | 199,649 | 89,211 | -55.3% |
| Reconcile input tokens | 108,954 | 60,347 | -44.6% |
| Reconcile total tokens | 110,665 | 61,655 | -44.3% |
| Final status | reconcile_failed | reconcile_failed | unchanged |

The unchanged request count is expected in Phase 1: the old tool-calling Final Reconcile still loops until its 12-request budget even when only three genuine cases remain. Removing that loop belongs to the later V2 pipeline work; Phase 1's goal is to stop ordinary semantic pending relations from manufacturing Final cases.

The 3 remaining cases are exactly the intended classes at this stage: 1 cast/identity conflict and 2 real evidence-localization failures.

## Verification

- 20 ordinary located `pending` relations create zero `MissingEvidence` cases.
- `reconcile_book()` skips `run_reconcile_agent()` when the only relation is located but semantically pending.
- Empty / unmatched / non-unique evidence still creates a `MissingEvidence` case.
- Rejected relations do not create evidence-repair cases.
- Backend suite: **137 passed**, 3 deprecation warnings.
- Siddhartha Gold: **VALIDATION OK**.
- Evaluator regression tests: **6 passed**.
