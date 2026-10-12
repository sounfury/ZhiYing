# Woodpecker 代码质量门禁

仓库：`sounfury/ZhiYing`。CI：<https://ci.oci.sounfury.top>（Woodpecker `v3.19.0`）。

Kotlin 检查用 **detekt `2.0.0-alpha.6`**。最新稳定 1.x 是 `1.23.8`，官方已不再维护，且对不上本仓库的 Kotlin `2.4.20` / Gradle `9.8` / JDK 25。2.0 仍是 alpha，阈值取该版默认配置。

## 文件位置

| 检查 | 工作流 | 配置 | 默认阈值 |
| --- | --- | --- | --- |
| 文件/类行数 | `.woodpecker/文件行数.yaml` | `quality/detekt-file-length.yml` | `LargeClass.allowedLines=600`（detekt 没有整文件行数规则，这是类主体默认值） |
| 认知复杂度 | `.woodpecker/认知复杂度.yaml` | `quality/detekt-complexity.yml` | `CognitiveComplexMethod.allowedComplexity=15`（默认未启用，本门禁打开） |
| 嵌套深度 | `.woodpecker/嵌套深度.yaml` | `quality/detekt-nesting.yml` | `NestedBlockDepth.allowedDepth=4` |
| 参数个数 | `.woodpecker/参数个数.yaml` | `quality/detekt-params.yml` | 函数 5 / 构造 6 |
| 死代码 | `.woodpecker/死代码.yaml` | `quality/detekt-dead-code.yml` | UnusedImport/Parameter/Private*/Variable |
| 重复代码 | `.woodpecker/重复代码.yaml` | `quality/jscpd.json` | ≥5 行且 ≥50 token，阈值 0%；忽略评测历史报告、`.backup`、detekt 默认配置互拷；`ignorePattern` 跳过 `import`/`package` 行 |
| 密钥扫描 | `.woodpecker/密钥扫描.yaml` | `quality/gitleaks.toml` | gitleaks 默认规则，不可跳过 |

Kotlin 门禁只在 `zhiying_backend/**/*.kt`（以及本目录配置）变更时跑。重复代码和密钥扫描对每次 push / PR / 手动触发都跑。

GitHub PR 上的检查名是中文（文件行数、认知复杂度、嵌套深度、参数个数、死代码、重复代码、密钥扫描）。Woodpecker 网页本身在 **Settings → General → Language** 选简体中文。detekt / jscpd / gitleaks 的日志仍是工具原英文。

本机 detekt 镜像：`local/detekt-cli:2.0.0-alpha.6`（agent 与宿主机共用 Docker，`pull: false`）。重建：

```bash
docker build -t local/detekt-cli:2.0.0-alpha.6 \
  -f Dockerfile.detekt /path/to/detekt-cli-dir
```

## 怎么调阈值

改对应 `quality/` 文件里的注释旁数字，不要靠全局 ignore 或删规则把流水线变绿。

jscpd 的 `ignore` 只排除非源码噪声（`eval/**/legacy_reports/**` 评测历史、`.backup/**` 演示账本、`quality/detekt-*.yml` 默认配置互拷），不放宽 `threshold`。

jscpd v4 要在每个文件写 `jscpd:ignore-start` 才能跳过 import。v5 用 `ignorePattern` 对原文做正则匹配，跳过的 token 不参与查重，不改源码。当前跳过 `^import ` / `^package ` 整行。

## 怎么跳过某一项（密钥扫描除外）

1. **失败不阻断**：手动跑流水线时设 `FILE_LENGTH_NONBLOCK=true`（或 `COMPLEXITY_` / `NESTING_` / `PARAMS_` / `DEAD_CODE_` / `DUPLICATION_`）。检查仍跑，红了不挡合并。
2. **临时关掉**：设 `SKIP_FILE_LENGTH=true`（同样前缀）。该工作流不跑检查步骤。

## 接到下一个仓库

1. 复制 `.woodpecker/` 和 `quality/`。
2. 按语言改路径过滤；Kotlin 继续用 detekt，Python 换成 Ruff/Pylint/complexipy/vulture。
3. 在 Woodpecker 登录后添加仓库；公开仓库保持 fork PR 需批准。
4. 本机若还没有 `local/detekt-cli:2.0.0-alpha.6`，按上面重建镜像。
