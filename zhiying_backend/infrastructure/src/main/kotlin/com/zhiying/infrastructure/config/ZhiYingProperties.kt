// 集中配置：项目自有的全部可调参数（zhiying.*）在此类型化绑定并校验，代码中不再散落 @Value。
package com.zhiying.infrastructure.config

import org.springframework.boot.context.properties.ConfigurationProperties
import org.springframework.boot.context.properties.EnableConfigurationProperties
import org.springframework.context.annotation.Configuration
import java.nio.file.Path
import java.time.Duration

/**
 * 项目配置根，对应 application.yml 中的 `zhiying.*`。
 *
 * 新增可调参数时在对应分组加字段并在 init 中校验；应用层需要的参数由基础设施组装成应用层自己的设置对象再注入，
 * 不让应用层依赖本类。启动时校验失败直接报错，不带病运行。
 */
@ConfigurationProperties(prefix = "zhiying")
data class ZhiYingProperties(
    val llm: LlmProperties,
    val storage: StorageProperties,
    val `import`: ImportProperties,
    val modelCall: ModelCallProperties = ModelCallProperties(),
    val reading: ReadingProperties = ReadingProperties(),
    val graph: GraphProperties = GraphProperties(),
    val postProcess: PostProcessProperties = PostProcessProperties(),
    val affiliations: AffiliationProperties = AffiliationProperties(),
    val analysis: AnalysisProperties = AnalysisProperties(),
    val eval: EvalProperties = EvalProperties(),
)

/**
 * 模型服务连接（OpenAI 兼容协议）。`spring.ai.openai.*` 从这里取值，保证只有一处来源。
 *
 * 入参：[baseUrl] 服务地址；[apiKey] 密钥；[model] 默认对话模型名。
 */
data class LlmProperties(val baseUrl: String, val apiKey: String, val model: String) {
    init {
        require(baseUrl.isNotBlank()) { "zhiying.llm.base-url 不能为空" }
        require(apiKey.isNotBlank()) { "zhiying.llm.api-key 不能为空，请在 .env 中设置 LLM_API_KEY" }
        require(model.isNotBlank()) { "zhiying.llm.model 不能为空" }
    }

    /** 打印配置时隐藏密钥。 */
    override fun toString() = "LlmProperties(baseUrl=$baseUrl, model=$model)"
}

/**
 * 评测（DESIGN §7）：[dir] 评测目录，下面每个含 `suite.json` 的子目录是一个评测集，运行记录写到 `runs/`；
 * 相对路径按启动目录解析（bootRun 为 zhiying_backend/）。以字符串绑定：Spring 把 `../` 开头的值按资源路径转换 Path 会失败。
 */
data class EvalProperties(val dir: String = "../eval") {
    /** 评测目录。 */
    val path: Path get() = Path.of(dir)
}

/**
 * 本地存储位置。数据库文件与书籍源文件都放在 [dataDir] 下；不存在时启动自动创建。
 *
 * 入参：[dataDir] 数据目录，相对路径按启动目录解析（bootRun 为 zhiying_backend/）。
 */
data class StorageProperties(val dataDir: Path) {
    /** SQLite 数据库文件。 */
    val databaseFile: Path get() = dataDir.resolve("zhiying.db")

    /** 书籍源文件（EPUB 等）目录。 */
    val booksDir: Path get() = dataDir.resolve("books")
}

/**
 * 书籍导入参数（zhiying.import.*）。
 *
 * 入参：[minChapterWords] 章节参与分析的最低字数，低于它的章节仍保留在书中但标记为不参与分析；
 * [maxTitleLineLength] 正则切章时，章节标记所在行不超过此长度就整行作为章节标题。
 */
data class ImportProperties(val minChapterWords: Int, val maxTitleLineLength: Int) {
    init {
        require(minChapterWords >= 0) { "zhiying.import.min-chapter-words 不能为负" }
        require(maxTitleLineLength >= 0) { "zhiying.import.max-title-line-length 不能为负" }
    }
}

/**
 * 出图参数（zhiying.graph.*）：展示分 = 类型基础分 + 出现章数 × [perChapter] + 带原文片段证据加分，只用于排序与默认过滤。
 *
 * 入参：[hardBase]、[mediumBase]、[softBase] 各硬度的基础分；[defaultMinAppearance] 路人过滤的默认最少出场章数。
 */
data class GraphProperties(
    val hardBase: Double = 30.0,
    val mediumBase: Double = 20.0,
    val softBase: Double = 10.0,
    val perChapter: Double = 0.5,
    val quotedEvidenceBonus: Double = 1.0,
    val defaultMinAppearance: Int = 2,
) {
    init {
        require(defaultMinAppearance >= 0) { "zhiying.graph.default-min-appearance 不能为负" }
    }
}

/**
 * 团体归纳参数（zhiying.affiliations.*）：全书级一次结构化调用，输入过大时按重要度与出场数裁剪。
 *
 * 入参：[model] 专用模型名，空则用 `zhiying.llm.model`；[thinking] 是否开启思考；
 * [minGroups]、[maxGroups] 提示中建议的团体数范围；[maxPersons] 人名册最多带入的人数（按重要度、出场章数取前）；
 * [maxProfileChars] 单个人物资料截断字数；[maxChapters] 最多带入的章摘要数（超出时均匀抽样）；
 * [maxSummaryChars] 单章摘要截断字数；[maxObservationsPerChapter] 每章最多带入的章内观察数；
 * [maxObservationChars] 单条观察截断字数；[maxRelations] 关系骨架最多条数（按出现章数取前）。
 */
data class AffiliationProperties(
    val model: String = "",
    val thinking: Boolean = false,
    val minGroups: Int = 5,
    val maxGroups: Int = 12,
    val maxPersons: Int = 300,
    val maxProfileChars: Int = 60,
    val maxChapters: Int = 200,
    val maxSummaryChars: Int = 200,
    val maxObservationsPerChapter: Int = 3,
    val maxObservationChars: Int = 80,
    val maxRelations: Int = 220,
) {
    init {
        require(minGroups >= 1 && maxGroups >= minGroups) { "zhiying.affiliations 团体数范围不合法" }
        require(maxPersons >= 1 && maxChapters >= 1 && maxRelations >= 0) { "zhiying.affiliations 输入上限不合法" }
        require(maxProfileChars >= 1 && maxSummaryChars >= 1 && maxObservationChars >= 1) { "zhiying.affiliations 截断字数不合法" }
        require(maxObservationsPerChapter >= 0) { "zhiying.affiliations.max-observations-per-chapter 不能为负" }
    }
}

/** 启用 [ZhiYingProperties] 绑定；放在基础设施层，web 编译期无需感知配置类。 */
@Configuration(proxyBeanMethods = false)
@EnableConfigurationProperties(ZhiYingProperties::class)
class ZhiYingConfiguration

/**
 * 模型调用执行政策（对应 `zhiying.model-call.*`），所有调用点共用；SDK 自带重试已关闭，重试只在这里发生。
 *
 * 入参：[timeout] 单次请求超时；[maxRetries] 失败后最多重试次数（仅限限流、超时、网络、服务端错误）；
 * [retryBaseDelay]、[retryMaxDelay] 指数退避的起始与上限；[maxConcurrentRequests] 全局同时在途的请求数；
 * [parseRetries] 结构化回复无法解析或校验失败时，带着错误信息要求模型重答的次数；[temperature] 采样温度。
 */
data class ModelCallProperties(
    val timeout: Duration = Duration.ofSeconds(120),
    val maxRetries: Int = 2,
    val retryBaseDelay: Duration = Duration.ofMillis(500),
    val retryMaxDelay: Duration = Duration.ofSeconds(8),
    val maxConcurrentRequests: Int = 8,
    val parseRetries: Int = 1,
    val temperature: Double = 0.0,
) {
    init {
        require(!timeout.isNegative && !timeout.isZero) { "zhiying.model-call.timeout 必须为正" }
        require(maxRetries >= 0) { "zhiying.model-call.max-retries 不能为负" }
        require(maxConcurrentRequests >= 1) { "zhiying.model-call.max-concurrent-requests 至少为 1" }
        require(parseRetries >= 0) { "zhiying.model-call.parse-retries 不能为负" }
    }
}

/**
 * 章阅读参数（对应 `zhiying.reading.*`）。
 *
 * 入参：[model] 章阅读专用模型名，空则用 `zhiying.llm.model`；[thinking] 是否开启思考模式；
 * [baseSteps] 短章工具循环最大步数；[maxSteps] 长章步数上限（长章按窗数 15 + 2 × 窗数，不超过该值）；
 * [injectMaxChars] 不超过该字数的章节整章注入提示；[readWindowChars] 分段读取时每窗最大字数；
 * [maxRequests]、[maxTokens] 单章请求数与 token 预算；[submitNudges] 模型不调工具也未提交时，提醒其提交的次数；
 * [segmentMaxChars] 阅读单元字数上限，超过的章按 ⌈字数 / 上限⌉ 均分成多段（短章不合并）；
 * [segmentHintChars] 段首附上一段末尾的提示字数（仅供衔接，不归本段抽取），0 表示不附。
 */
data class ReadingProperties(
    val model: String = "",
    val thinking: Boolean = false,
    val baseSteps: Int = 20,
    val maxSteps: Int = 60,
    val injectMaxChars: Int = 10_000,
    val readWindowChars: Int = 5_000,
    val maxRequests: Long = 60,
    val maxTokens: Long = 400_000,
    val submitNudges: Int = 1,
    val segmentMaxChars: Int = 20_000,
    val segmentHintChars: Int = 300,
) {
    init {
        require(baseSteps >= 1 && maxSteps >= baseSteps) { "zhiying.reading 步数配置不合法" }
        require(injectMaxChars >= 1 && readWindowChars >= 1) { "zhiying.reading 字数配置不合法" }
        require(submitNudges >= 0) { "zhiying.reading.submit-nudges 不能为负" }
        require(segmentMaxChars >= 1 && segmentHintChars >= 0) { "zhiying.reading 切段配置不合法" }
    }
}

/**
 * 整书分析编排参数（对应 `zhiying.analysis.*`）。
 *
 * 入参：[concurrency] 同时在读的阅读单元数；[maxRequests]、[maxTokens] 整个任务的模型请求数与 token 预算，0 表示不限。
 */
data class AnalysisProperties(
    val concurrency: Int = 4,
    val maxRequests: Long = 0,
    val maxTokens: Long = 0,
) {
    init {
        require(concurrency >= 1) { "zhiying.analysis.concurrency 至少为 1" }
        require(maxRequests >= 0 && maxTokens >= 0) { "zhiying.analysis 预算不能为负" }
    }
}

/**
 * 分析后处理参数（对应 `zhiying.post-process.*`）：身份歧义、类型归一、定向补查、软兜底四个模型调用点共用。
 *
 * 入参：[model] 后处理专用模型名，空则用 `zhiying.llm.model`；[thinking] 是否开启思考；
 * [identityMaxItems]/[identityMaxChars]、[typeMaxItems]/[typeMaxChars]、[recheckMaxItems]/[recheckMaxChars]、
 * [fallbackMaxItems]/[fallbackMaxChars] 各步骤单次请求的条数与近似输入字符数上限；
 * [recheckMaxRequests] 整个分析最多发出的补查请求数，超出的记录保持未决；
 * [mentionsPerPerson] 身份判断中每个候选人物最多附带的提及条数；[fallbackInteractionsPerPair] 软兜底每个人物对最多附带的交流观察数；
 * [typeCandidateLimit] 类型归一每个问题最多列出的候选类型数（类型库不超过它时全列）；
 * [maxNewTypeNameChars] 新类型名称最大字数，更长的视为情节句子而丢弃；
 * [coreMinAppearance] 重要人物的最少出场章数（与出图默认过滤一致），人物对至少一端达到才算重要对，两端都不到的路人对兜底直接贴「相识」；
 * [profileEnabled] 是否为重要人物生成全书简介；[profileMaxItems]/[profileMaxChars] 全书简介单次请求的人数与近似输入字符数上限；
 * [profileMentionsPerChapter] 每人每章最多附带的提及依据条数；[profileMaxChaptersPerPerson] 每人最多使用的章数，超过时均匀抽样并保留首末章；
 * [appellationBridgeLimit] 稳定称呼被不超过此人数的人物共用时，才参与身份候选桥接；
 * [recheckContext] 补查原文上下文的扩展上限。
 */
data class PostProcessProperties(
    val model: String = "",
    val thinking: Boolean = false,
    val identityMaxItems: Int = 8,
    val identityMaxChars: Int = 12_000,
    val typeMaxItems: Int = 10,
    val typeMaxChars: Int = 8_000,
    val recheckMaxItems: Int = 5,
    val recheckMaxChars: Int = 12_000,
    val recheckMaxRequests: Int = 20,
    val fallbackMaxItems: Int = 6,
    val fallbackMaxChars: Int = 12_000,
    val mentionsPerPerson: Int = 6,
    val fallbackInteractionsPerPair: Int = 12,
    val typeCandidateLimit: Int = 40,
    val maxNewTypeNameChars: Int = 12,
    val coreMinAppearance: Int = 2,
    val profileEnabled: Boolean = true,
    val profileMaxItems: Int = 8,
    val profileMaxChars: Int = 12_000,
    val profileMentionsPerChapter: Int = 3,
    val profileMaxChaptersPerPerson: Int = 12,
    val appellationBridgeLimit: Int = 4,
    val recheckContext: RecheckContextProperties = RecheckContextProperties(),
) {
    init {
        require(listOf(identityMaxItems, identityMaxChars, typeMaxItems, typeMaxChars, recheckMaxItems, recheckMaxChars, fallbackMaxItems, fallbackMaxChars).all { it >= 1 }) {
            "zhiying.post-process 批量上限必须为正"
        }
        require(coreMinAppearance >= 1) { "zhiying.post-process.core-min-appearance 至少为 1" }
        require(listOf(profileMaxItems, profileMaxChars, profileMentionsPerChapter, profileMaxChaptersPerPerson, appellationBridgeLimit).all { it >= 1 }) {
            "zhiying.post-process 全书简介与称呼桥接上限必须为正"
        }
        require(recheckMaxRequests >= 0) { "zhiying.post-process.recheck-max-requests 不能为负" }
        require(mentionsPerPerson >= 1 && fallbackInteractionsPerPair >= 1 && typeCandidateLimit >= 1 && maxNewTypeNameChars >= 1) { "zhiying.post-process 数量上限必须为正" }
    }
}

/**
 * 补查原文上下文的扩展上限（对应 `zhiying.post-process.recheck-context.*`）。
 *
 * 入参：[maxExcerptChars] 单个片段最多字符数；[maxExcerpts] 每条记录最多片段数；
 * [neighborParagraphs] 按动作扩展时，所在段落前后最多再带的段数；
 * [dialogueMaxParagraphs] 处理指代时沿对话向前 / 向后最多追溯的段数。
 */
data class RecheckContextProperties(
    val maxExcerptChars: Int = 2_000,
    val maxExcerpts: Int = 3,
    val neighborParagraphs: Int = 2,
    val dialogueMaxParagraphs: Int = 6,
) {
    init {
        require(maxExcerptChars >= 1 && maxExcerpts >= 1) { "zhiying.post-process.recheck-context 上限必须为正" }
        require(neighborParagraphs >= 0 && dialogueMaxParagraphs >= 0) { "zhiying.post-process.recheck-context 段数不能为负" }
    }
}
