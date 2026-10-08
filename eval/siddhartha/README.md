# 《悉达多》评测集

评分口径、流程与运行记录见 [DESIGN §7](../../docs/DESIGN.md)。评测在前端评测页（`/eval`）发起，本目录只放标准标注。

范围：正文第 1–12 章，对应导入后参与分析的 12 章（目录、扉页、分部页、译后记都不参与分析）。

## 文件

- `suite.json`：书名、源 EPUB 路径（相对本目录，EPUB 不入库）、正文章数、标准人物与别名
- `chapter_001.json` ~ `chapter_012.json`：逐章标准
- `legacy_reports/`：旧 Python 后端的历史报告，口径不同，只作参照

改标注后不用重启后端，下次评分即生效。

## 逐章标准（schema 2.0）

```jsonc
{
  "chapter": 3,
  "title": "乔达摩",                       // 评分时与导入后的章名核对
  "required_relations": [{                 // 必有：计入召回
    "person_a": "乔达摩", "person_b": "乔文达",
    "label": "师徒",                        // 只给人看
    "types": ["mentor_of"],                 // 可接受的内置类型 ID
    "keywords": [],                         // 本书新类型名称含任一关键词也算
    "source": "乔达摩",                     // 有向时的源端；无向不写
    "tier": "hard",                         // 可选：hard / medium / soft，不写时按可接受类型推断
    "evidence": [{ "quote": "…" }],          // 标准引文，评分时自检能否在正文找到
    "note": "…"
  }],
  "optional_relations": [ /* 同上；命中不算错，漏掉不扣分 */ ],
  "forbidden_relations": [{                // 禁止：同章出现已准入的这些类型即违反，不分方向
    "person_a": "悉达多", "person_b": "乔达摩",
    "types": ["mentor_of"], "keywords": [], "reason": "…", "evidence": []
  }]
}
```

`characters`（出场方式）与 `identity_assertions`（同人断言）只给人看，评分不读；人物别名以 `suite.json` 为准。

内置类型 ID 见 `zhiying_backend/domain/.../relations/BuiltInRelationTypes.kt`。

## 类型映射（2026-10-09 由旧自由标签改写，待人工复核）

师徒 `mentor_of` 与师生 `teacher_student_of` 视为同一类：凡接受或禁止其一，另一个同样接受或禁止。

必有关系分强 / 中 / 弱三档计分（权重 1 / 0.6 / 0.3，DESIGN §7.3）。档位可用 `"tier": "hard" | "medium" | "soft"` 指定；不写时按可接受类型推断：含软关系（如 `friend_of`）为弱，含硬关系（如 `mentor_of`、`lover_of`）为强，其余为中。弱关系在两人本章已有强 / 中关系时漏掉不扣分。

| 旧标签 | 可接受类型 |
|---|---|
| 朋友、青年好友等 | 朋友 `friend_of`、挚友 `close_friend_of` |
| 同修挚友（第 2 章） | 朋友、挚友、同行 `companion_of`、同门 `fellow_disciple_of` |
| 师徒（乔达摩 → 乔文达） | 师徒、师生 |
| 布施供养（给孤独 → 乔达摩） | 恩人 `benefactor_of`；新类型含「供养 / 布施 / 施主 / 追随 / 信徒」 |
| 精神启发者（第 4 章）、精神引导（第 11 章） | 师徒、师生；新类型含「启发 / 引导 / 导师」等（这两章不再设禁止项） |
| 欢爱之术老师（迦摩罗 → 悉达多） | 师生、师徒 |
| 情人、昔日恋人 | 恋人 `lover_of` |
| 商业共事 | 商业伙伴 `business_partner_of`、同事 `colleague_of`、雇佣 `employer_of` |
| 母子、父子 | 母亲 `mother_of` / 父亲 `father_of`、亲子 `parent_of` |
| 皈依信徒（迦摩罗 → 乔达摩） | 无合适内置类型，只认新类型「信徒 / 皈依 / 追随 / 供养 / 布施」 |
| 禁止的「正式师徒 / 皈依」 | 师徒、师生（第 2、3、8、12 章悉达多与乔达摩，第 9 章瓦稣迪瓦与悉达多）；第 5 章禁止悉达多与迦摩施瓦弥的商业伙伴、雇佣、师徒、师生（两人尚未见面） |

最需要复核的边界：

- 第 9 章瓦稣迪瓦与悉达多：瓦稣迪瓦自称不是导师，但悉达多确实拜他学摆渡；目前禁止师徒 / 师生，「摆渡学艺」只接受同事、同行与新类型
- 皈依信徒没有内置类型，模型不登记新类型就一定漏检
- 可有关系里的一次性行为（守候、施救、担忧、反抗）用「保护 / 互动 / 敌对」等兜底是否合适
