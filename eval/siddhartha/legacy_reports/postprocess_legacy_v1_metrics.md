# Siddhartha Legacy Postprocess Baseline

- Fixture SHA-256: `a396117ec1971838a5d00e5c9ff7f6b708b6b12cc7975e42da46531836ba80d4`
- Model: `deepseek-flash`
- Final status: `reconcile_failed`
- Reconcile done: `False`
- Total requests: **34**
- Message characters: **374070**
- Input tokens: **211361**
- Output tokens: **9661**
- Total tokens: **221022**
- Wall time: **49.53 s**
- Relations: **52** (confirmed 24, pending 28)
- Registry definitions: **34**
- Normalize model candidates: **50**
- Verify candidates: **50**
- Reconcile suspects: **29**

| Phase | Requests | Message chars | Input tokens | Output tokens | Total tokens | Errors |
|---|---:|---:|---:|---:|---:|---:|
| reconcile | 12 | 199649 | 108954 | 1711 | 110665 | 0 |
| relation_normalize | 11 | 74238 | 34236 | 3717 | 37953 | 0 |
| relation_verify | 11 | 100183 | 68171 | 4233 | 72404 | 0 |

## Stage timing

- rebuild: 0.062 s
- relations: 34.559 s
- reconcile: 14.852 s
