# Siddhartha Legacy Postprocess Baseline

- Fixture SHA-256: `a396117ec1971838a5d00e5c9ff7f6b708b6b12cc7975e42da46531836ba80d4`
- Model: `deepseek-flash`
- Final status: `reconcile_failed`
- Reconcile done: `False`
- Total requests: **34**
- Message characters: **263621**
- Input tokens: **162749**
- Output tokens: **9502**
- Total tokens: **172251**
- Wall time: **50.645 s**
- Relations: **52** (confirmed 21, pending 31)
- Registry definitions: **35**
- Normalize model candidates: **50**
- Verify candidates: **50**
- Reconcile suspects: **3**

| Phase | Requests | Message chars | Input tokens | Output tokens | Total tokens | Errors |
|---|---:|---:|---:|---:|---:|---:|
| reconcile | 12 | 89211 | 60347 | 1308 | 61655 | 0 |
| relation_normalize | 11 | 74226 | 34230 | 3997 | 38227 | 0 |
| relation_verify | 11 | 100184 | 68172 | 4197 | 72369 | 0 |

## Stage timing

- rebuild: 0.068 s
- relations: 36.042 s
- reconcile: 14.473 s
