# language: en
# 管理员后台、参数与提示快照、邀请码额度及 token 可见范围（PRD §5.9、§5.11、§5.13、§5.15–5.16）。
Feature: 后台统一管理用量、设置、模型、评测、账号与反馈

  @ADMIN_01
  Scenario Outline: 访客与普通用户不能读取后台
    Given 当前访问者为<身份>
    When 访问 /admin 或请求后台用量、设置、模型、评测、账号、反馈与模型诊断接口
    Then 页面不挂载管理功能，接口拒绝访问
    And 图谱与书架不显示后台入口

    Examples:
      | 身份     |
      | 访客     |
      | 普通用户 |

  @ADMIN_02
  Scenario: 管理员使用统一入口
    Given 当前访问者为管理员
    When 从书架或账号弹窗进入后台
    Then 用量、设置、模型、评测、账号与反馈功能在同一个后台页面按页签展示
    And 反馈管理地址为 /admin?tab=feedback
    And 访问旧 /eval 链接跳转到后台评测页签
    And 邀请码与重置密码沿用原有规则

  @ADMIN_03
  Scenario: 用量按配置时区汇总并保留历史
    Given 有已结算任务、运行中任务与已删除的书架条目
    When 管理员打开用量页签
    Then 看到今日与近 30 天的每日 token，今日包含未结算任务的实时 token
    And 日期按部署配置的时区与任务开始日统计
    And 看到各用户累计字数、token 与当前书数，以及各条目 token
    And 已删除条目的 token 仍计入用户和全站，并显示为已删除的书
    And 私人书条目不提供读取正文或结果的链接

  @ADMIN_04
  Scenario: 普通用户与访客在接口及界面都看不到 token
    Given 普通用户的书与公开示例书都有已用 token
    When 普通用户读取本人书列表、详情、任务快照与 SSE 进度或终态
    Then 响应不包含 token 与模型请求数用量字段，前端不显示这些数字
    And SSE 断线回放与服务重启后合成的终态也不包含这些用量字段
    And 本人额度接口仍返回书数与分析字数的已用值和上限
    When 访客读取公开示例书列表与详情
    Then 响应与前端不显示 token 用量

  @ADMIN_05
  Scenario: 模型覆盖只影响之后启动的任务
    Given 任务甲启动时使用模型配置 A
    When 管理员保存模型配置 B，修改模型名或思考开关
    Then 任务甲后续读章、后处理与团体归纳仍使用 A
    And 任务甲发布的方法版本由 A 计算
    When 任务乙之后启动
    Then 任务乙所有调用使用 B，并以 B 判定可沿用抽取及发布方法版本
    And 使用 A 的整书结果不再用于新上传的秒传
    And 页面提示修改配置对后续任务与秒传的影响

  @ADMIN_06
  Scenario: 没有内置服务商，未配置环节不能启动分析
    Given 部署配置不提供任何模型服务商
    When 管理员打开模型页签
    Then 未选择模型的环节显示「未配置」
    When 任一环节未配置时用户启动分析
    Then 拒绝启动并提示请管理员先配置模型
    And 后台与模型诊断响应都不包含服务地址或 API Key 明文

  @ADMIN_07
  Scenario: 管理员可测试指定模型的连接
    Given 管理员填写模型名与思考开关
    When 点击测试连接
    Then 使用所选服务商测试指定模型的对话、工具调用和结构化输出
    And 展示各项检查结果，失败也展示检查报告
    And 测试不会保存或改变正在运行任务的模型配置

  @ADMIN_08 @prd_5_15
  Scenario: 后台调整用量上限立即生效
    Given 每人书数上限为 0（不限）
    When 管理员在设置页签把每人书数改为 3
    Then 之后的上传按 3 本检查，不用重启
    When 管理员把单个文件大小设为超过部署上传硬上限的值
    Then 保存被拒绝并说明上限
    When 管理员恢复默认
    Then 页面显示默认值且标为未修改

  @ADMIN_09 @prd_5_15
  Scenario: 修改提示词只影响之后启动的任务
    Given 任务甲已启动
    When 管理员修改读章提示词并保存
    Then 任务甲后续读章仍使用启动时的提示词
    And 之后启动的任务使用新提示词，用旧提示词读的章在继续分析时重读
    And 用旧提示词得到的整书结果不再用于秒传
    When 管理员保存含未知占位符或空白的提示词
    Then 保存被拒绝并指出问题
    When 管理员恢复默认提示词
    Then 已有用默认提示词得到的结果重新可沿用与秒传

  @ADMIN_10 @prd_5_15
  Scenario: 通用设置按顺序返回参数组与部署默认值
    Given 管理员未覆盖任何分析参数
    When 请求 GET /api/admin/settings
    Then 分组顺序为 quota、params、prompt，model 不在通用设置列表中
    And params 的 label 为「提示词参数」，包含 read_window_chars、min_groups、max_groups，类型均为 count 且 min 为 1
    And read_window_chars 的 hint 说明它同时是长章分段读取的实际每窗字数
    And 三个参数的当前值与默认值均为对应部署配置，标为未修改
    And quota 包含默认值为 0 的 max_tokens

  @ADMIN_11 @prd_5_15
  Scenario Outline: 分析参数只接受正整数
    Given 当前生效参数合法
    When 管理员将 params 中的<参数>保存为<值>
    Then 返回 INVALID_ARGUMENT，参数与覆盖记录保持原状

    Examples:
      | 参数              | 值   |
      | read_window_chars | 0    |
      | read_window_chars | -1   |
      | read_window_chars | 1.5  |
      | min_groups        | 0    |
      | min_groups        | -1   |
      | min_groups        | 1.5  |
      | max_groups        | 0    |
      | max_groups        | -1   |
      | max_groups        | 1.5  |

  @ADMIN_12 @prd_5_15
  Scenario Outline: 保存和恢复默认均按整组生效值校验团体范围
    Given 团体数部署默认范围为 5 至 12，当前生效范围为<下限>至<上限>
    When 管理员<操作>
    Then 返回 INVALID_ARGUMENT，原生效值与覆盖记录保持不变

    Examples:
      | 下限 | 上限 | 操作                         |
      | 5    | 12   | 保存 min_groups 为 13        |
      | 5    | 12   | 保存 max_groups 为 4         |
      | 2    | 3    | 恢复 min_groups 为部署默认值 |
      | 15   | 20   | 恢复 max_groups 为部署默认值 |

  @ADMIN_13 @prd_5_15
  Scenario: 参数随任务快照且阅读窗口实际生效
    Given 任务甲登记时阅读窗口为 5000，团体范围为 5 至 12
    And 读章提示词未引用 read_window_chars 占位符
    When 管理员将阅读窗口改为 2000，团体范围改为 3 至 8
    Then 任务甲仍使用 5000 的实际分段阅读窗口和 5 至 12 的团体参数
    When 任务乙登记并执行分段阅读和团体归纳
    Then 每次读取正文不超过 2000 字，团体提示使用 3 至 8
    And 提示词及参数渲染、实际读取和版本计算均使用各自任务的同一快照

  @ADMIN_14 @prd_5_15
  Scenario Outline: 参数只改变对应提示版本并影响结果沿用
    Given 已有使用默认参数的章抽取和完整整书结果
    When 管理员将<参数>改为不同于默认值的合法值
    Then 之后任务的<提示版本>及整书方法版本变化，旧整书结果不再用于秒传
    And 其他调用点的提示版本不变
    And 旧章抽取<沿用结果>

    Examples:
      | 参数              | 提示版本     | 沿用结果       |
      | read_window_chars | 读章提示版本 | 不能沿用须重读 |
      | min_groups        | 团体提示版本 | 仍可沿用       |
      | max_groups        | 团体提示版本 | 仍可沿用       |

  @ADMIN_15 @prd_5_15
  Scenario: 相同默认参数不产生额外版本且支持合法的相等边界
    Given 提示词与模型不变，已有使用部署默认参数的完整结果
    When 管理员显式保存与默认值相同的三个参数
    Then 对应提示版本、阅读来源与方法版本保持默认版本，已有结果仍可沿用与秒传
    When 管理员将 min_groups 与 max_groups 设为相等的正整数
    Then 保存成功
    When 管理员按合法顺序恢复三个参数为默认值
    Then 版本与原默认配置一致，默认结果重新可沿用与秒传

  @ADMIN_16 @prd_5_11 @prd_5_13
  Scenario Outline: 邀请码创建和列表保留可空额度原值
    Given 当前访问者为管理员
    When 创建邀请码时将 maxBooks 与 maxTokens 均设为<输入>
    Then 创建成功，创建响应与邀请码列表均显式返回两个字段为<返回值>

    Examples:
      | 输入 | 返回值 |
      | 省略 | null   |
      | null | null   |
      | 0    | 0      |
      | 20   | 20     |

  @ADMIN_17 @prd_5_11 @prd_5_13
  Scenario Outline: 邀请码额度拒绝负数和非整数
    Given 当前访问者为管理员
    When 创建邀请码时将<字段>设为<值>
    Then 返回 INVALID_ARGUMENT，不创建邀请码

    Examples:
      | 字段      | 值   |
      | maxBooks  | -1   |
      | maxBooks  | 1.5  |
      | maxTokens | -1   |
      | maxTokens | 1.5  |

  @ADMIN_18 @prd_5_11 @prd_5_13
  Scenario: 注册在同一事务复制额度并消耗邀请名额
    Given 邀请码 maxBooks 为 null、maxTokens 为 1000，剩余 1 个名额
    When 用户凭该邀请码注册成功
    Then accounts 中 max_books 为 NULL、max_tokens 为 1000，邀请码恰好消耗 1 个名额
    And 之后邀请码规则变化不改变该账号已获得的规则
    When 使用另一个有剩余名额的邀请码注册，在创建账号或复制额度时失败
    Then 不留下新账号，不消耗该次邀请名额

  @ADMIN_19 @prd_5_13
  Scenario: 个人额度按字段继承且本人用量仅返回现有字段
    Given 普通账号的 max_books 为 NULL、max_tokens 为 0
    And 全站 max_books 为 3、max_tokens 为 1000，其他额度充足
    When 请求 GET /api/me/usage
    Then 响应只含 books 与 chars，books.limit 为 3，不新增 token 字段
    When 管理员将全站 max_books 改为 5、max_tokens 改为 2000
    Then 该账号的 books.limit 为 5，个人累计 token 仍不限
    When 该账号流水累计 token 已超过 2000 后启动分析
    Then 不因个人 token 额度拒绝
    And 账号 max_books 为 2、max_tokens 为 NULL 时，生效上限分别为 2 与 2000

  @ADMIN_20 @prd_5_13
  Scenario Outline: 个人流水累计 token 达到上限时拒绝新分析
    Given 普通账号生效 max_tokens 为 1000，usage_ledger 累计 tokens 为<累计>
    And 模型已配置且其他额度充足
    When 启动<任务>
    Then 返回 QUOTA_EXCEEDED，消息为「分析额度已用完」
    And 不创建任务或流水，已有结果仍可浏览

    Examples:
      | 累计 | 任务     |
      | 1000 | 整书分析 |
      | 1001 | 整书分析 |
      | 1000 | 单章重跑 |
      | 1001 | 单章重跑 |

  @ADMIN_21 @prd_5_13
  Scenario: token 只在启动前检查且删书清空不退还
    Given 普通账号生效 max_tokens 为 1000，流水累计为 900，其他额度充足
    When 启动分析并在运行中累计消耗超过个人上限
    Then 任务继续完成，不因个人 token 上限中途停止
    And 结束结算时将 token 写入任务流水并计入该用户累计
    When 用户清空分析或删除书架条目后再次启动其他分析
    Then 已结算累计 token 不减少，启动返回 QUOTA_EXCEEDED 与「分析额度已用完」

  @ADMIN_22 @prd_5_13
  Scenario: 管理员豁免个人额度但保留文件和全站限制
    Given 管理员已达到个人书数、字数、累计 token 与同时任务数上限
    And 文件大小、全站每日预算与模型配置均满足要求
    When 上传书或启动整书分析、单章重跑
    Then 不因个人额度拒绝，GET /api/me/usage 的个人 limit 均为 0
    And 文件大小限制仍生效，分析消耗仍计入全站预算，全站预算用尽仍拒绝新分析

  @ADMIN_23 @prd_5_11 @prd_5_13
  Scenario: 旧库启动检查补列并保留原数据
    Given 旧数据库的 accounts 和 invitations 缺少部分或全部 max_books、max_tokens 列
    When 服务启动并再次启动
    Then 仅补缺失列，旧记录新增字段为 NULL 并继承全站上限
    And 已有个人额度、账号、邀请码、使用次数、书籍与分析数据保持不变
