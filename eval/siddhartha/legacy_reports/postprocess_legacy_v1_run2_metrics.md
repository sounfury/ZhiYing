# Siddhartha Legacy Postprocess Baseline

- Fixture SHA-256: `a396117ec1971838a5d00e5c9ff7f6b708b6b12cc7975e42da46531836ba80d4`
- Model: `deepseek-flash`
- Final status: `reconcile_failed`
- Reconcile done: `False`
- Total requests: **34**
- Input tokens: **171813**
- Output tokens: **9698**
- Total tokens: **181511**
- Wall time: **53.157 s**
- Relations: **52** (confirmed 20, pending 32)
- Registry definitions: **34**

| Phase | Requests | Input tokens | Output tokens | Total tokens | Errors |
|---|---:|---:|---:|---:|---:|
| reconcile | 12 | 69412 | 1682 | 71094 | 0 |
| relation_normalize | 11 | 34230 | 3841 | 38071 | 0 |
| relation_verify | 11 | 68171 | 4175 | 72346 | 0 |

## Stage timing

- rebuild: 0.075 s
- relations: 36.339 s
- reconcile: 16.688 s
