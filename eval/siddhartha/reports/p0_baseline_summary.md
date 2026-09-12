# Siddhartha P0 Baseline Summary

Generated during V2 Phase 0 using the fixed raw extraction fixture.

## Fixed raw fixture

- Provider: `https://api.deepseek.com`
- Model: `deepseek-flash`
- Fixture SHA-256: `a396117ec1971838a5d00e5c9ff7f6b708b6b12cc7975e42da46531836ba80d4`
- Chapters: 12/12 captured from scratch; no reused snapshots; no capture exceptions
- Chapter Agent requests: 41
- Input tokens: 350,561
- Output tokens: 62,466
- Total tokens: 413,027
- Wall time: 77.839 s
- Note: the production default `ANALYSIS_MAX_LLM_TOKENS=400000` is slightly below the observed complete raw extraction cost. The fixture capture temporarily disabled the total-token cap only for baseline measurement; production defaults were not changed.

## Existing E2E reference

- Existing Siddhartha E2E evaluator score: **85.01 / 100**
- This score is retained as the historical end-to-end reference. It is not directly comparable to the fixed-raw postprocess runs because the Chapter Agent input/output generation differs.

## Fixed-raw legacy postprocess replay

Three runs used the exact same fixture and the current legacy pipeline:

`raw fixture -> CastWriter rebuild -> per-chapter relation normalize -> per-chapter evidence verify -> Final Reconcile`

| Metric | Run 1 | Run 2 | Run 3 (canonical telemetry) |
|---|---:|---:|---:|
| Evaluator score | 77.72 | 77.72 | 77.72 |
| Total LLM requests | 34 | 34 | 34 |
| Message characters | - | - | 374,070 |
| Total input tokens | 223,713 | 171,813 | 211,361 |
| Total output tokens | 10,305 | 9,698 | 9,661 |
| Total tokens | 234,018 | 181,511 | 221,022 |
| Wall time | 48.579 s | 53.157 s | 49.530 s |
| relation_normalize requests | 11 | 11 | 11 |
| relation_verify requests | 11 | 11 | 11 |
| reconcile requests | 12 | 12 | 12 |
| Final status | `reconcile_failed` | `reconcile_failed` | `reconcile_failed` |
| Stop reason | `reconcile request budget exceeded (12)` | `reconcile request budget exceeded (12)` | `reconcile request budget exceeded (12)` |
| Confirmed relations | 26 | 20 | 24 |
| Pending relations | 26 | 32 | 28 |
| Registry definitions | 35 | 34 | 34 |
| Reconcile suspects | 27 | 33 | 29 |

### Phase breakdown

| Phase | Run 1 tokens | Run 2 tokens | Run 3 tokens | Run 3 message chars |
|---|---:|---:|---:|---:|
| relation_normalize | 39,155 | 38,071 | 37,953 | 74,238 |
| relation_verify | 72,424 | 72,346 | 72,404 | 100,183 |
| reconcile | 122,439 | 71,094 | 110,665 | 199,649 |

Run 3 also records case counts on the same fixed raw input:

- relation-normalize model candidates: **50**
- relation-verify candidates: **50**
- reconcile suspects: **29** = 1 cast conflict + 0 relation conflicts + 28 missing-evidence suspects

## P0 conclusions

1. The fixed input is reproducible enough for quality comparison: all three legacy replays scored exactly **77.72** on the evaluator.
2. The legacy request topology is deterministic at this scale: **11 normalize + 11 verify + 12 reconcile = 34 LLM requests** in every run.
3. The Final Reconcile does not complete before the current phase request budget is exhausted. A simple 12-chapter book reaches **12 reconcile requests and still fails to submit**.
4. Even before Final Reconcile, normalize + verify already consume **22 requests** and roughly **110k tokens**, because both phases operate chapter-by-chapter rather than whole-book semantic clustering.
5. Ordinary pending evidence dominates Final Reconcile work: the three runs enter reconcile with **27 / 33 / 29 suspects**, of which **26 / 32 / 28** are missing-evidence suspects. This directly confirms the Phase 1 problem: ordinary pending evidence is being promoted into Final Reconcile work.
6. Run 3 sent **374,070 explicit message characters** in postprocess; Final Reconcile alone accounts for **199,649 characters**, more than half of the explicit prompt payload.
7. Total postprocess tokens vary substantially (**181,511–234,018**) because the model/tool path is stochastic, but the evaluator score and request topology remain stable.
8. These measurements are the fixed-raw legacy baseline for V2. V2 should compare against this fixture without invoking Chapter Agent.

## Validation status

- Backend test suite: **132 passed**, 3 deprecation warnings
- Siddhartha Gold validation: **VALIDATION OK**
- Evaluator regression tests: **6 passed**
