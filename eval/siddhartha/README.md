# 《悉达多》Gold 评测集

范围：正文第 1–12 章。第 13 章《译后记》在源数据中 `include_in_analysis=false`，不参与评测。

## 文件

- `manifest.json`：全局人物、别名合并规则、计分口径。
- `chapter_001.json` ~ `chapter_012.json`：逐章 Gold。
- `build_gold.py`：从人工整理的数据定义重新生成 12 个 JSON。
- `validate_gold.py`：校验 JSON、人物端点、章节标题，并确保每条 Gold evidence quote 能在原章节正文中精确匹配。

## 三层关系

- `required_relations`：高置信、应计入召回的核心关系。
- `optional_relations`：合理但偏事件性、回忆性或边界较软；预测出来不应算幻觉，漏掉也不扣核心召回。
- `forbidden_relations`：高价值负例。模型若生成这些关系，应单独计入语义错误/幻觉率。

## 人物同一性

最重要的硬规则之一：`乔达摩 = 佛陀 = 世尊 = 释迦摩尼`，必须合并为同一人物节点。

## 当前规模

当前版本：

- 12 个章节文件
- 24 条 required relations
- 15 条 optional relations
- 8 条 forbidden relations
- 51 条可精确定位的 evidence quotes

运行：

```powershell
python .\eval\siddhartha\validate_gold.py
```

验证成功应输出 `VALIDATION OK`。

## Evaluator

对当前 workspace 实际输出跑分：

```powershell
python .\eval\siddhartha\evaluate.py
```

默认会读取 `manifest.json` 中的 `book_id`，评测对应 `workspace/<book_id>/cast.json` 与 `ledger/chapter_001.json` ~ `chapter_012.json`，并生成：

- `reports/latest.json`：机器可读完整明细
- `reports/latest.md`：人类可读报告

也可以显式指定另一次运行产物：

```powershell
python .\eval\siddhartha\evaluate.py --workspace D:\path\to\book-workspace --report-dir D:\path\to\report
```

当前总分权重：人物 Entity F1 15%、同人合并 10%、required 关系召回 35%、forbidden 避免 15%、证据精确命中 10%、关系去重 10%、章节输出覆盖 5%。`optional_relations` 只做诊断，不进入总分。

由于开放关系 Gold 有意不穷举所有一次性互动，Evaluator **不会**把所有未标注预测直接当 false positive；只对 Gold 已裁决的 required / optional / forbidden 关系计算 `adjudicated_precision`，其余放入 `unscored_predictions` 等待人工扩充 Gold。

回归测试：

```powershell
python .\eval\siddhartha\test_evaluate.py
```

## P0 fixed-raw baseline

关系后处理 V2 的 A/B 不再每次重跑 Chapter Agent，而是固定使用：

`eval/siddhartha/fixtures/raw_legacy_v1/`

当前 fixture SHA-256：

`a396117ec1971838a5d00e5c9ff7f6b708b6b12cc7975e42da46531836ba80d4`

重新采集 raw fixture（会真实调用模型）：

```powershell
cd .\backend
uv run --with-requirements requirements.txt python ..\eval\siddhartha\capture_raw_fixture.py --reset --overwrite-fixture --analysis-max-llm-tokens 0
```

从固定 fixture 重放 legacy postprocess：

```powershell
cd .\backend
uv run --with-requirements requirements.txt python ..\eval\siddhartha\run_postprocess_baseline.py --reset
```

Phase 0 的完整结果见 `reports/p0_baseline_summary.md`。后续 V2 性能/质量比较必须复用同一 raw fixture，不得把重新抽取造成的随机差异混入 postprocess A/B。

## 人工复核建议

优先复核 `optional_relations` 和“精神启发者/前辈与师长/经商指导”等语义边界项。`required_relations` 已尽量限定为原文直接支持、适合做强制机器评分的关系。
