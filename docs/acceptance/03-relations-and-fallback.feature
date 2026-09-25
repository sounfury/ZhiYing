# language: en
@confirmed @prd_5_5
Feature: 多标签关系与有依据的软兜底
  场景中的人物都满足显示条件；类型、语义判断和互动观察由测试输入明确提供。

  @RELATION_01
  Scenario Outline: 强关系标签互不覆盖
    Given 甲与乙已有合格的“<已有标签>”关系
    And 新分析得到合格的“<新增标签>”关系
    When 系统汇总甲与乙的关系
    Then 同时保留“<已有标签>”和“<新增标签>”
    And 不因展示分不同删除其中一个标签
    Examples:
      | 已有标签 | 新增标签 |
      | 师徒     | 夫妻     |
      | 夫妻     | 结盟     |
      | 同门     | 结盟     |

  @RELATION_02
  Scenario Outline: 已成立硬中关系阻止生成新的软标签
    Given 甲与乙已有合格的“<强关系>”关系
    And 新章节记录了甲与乙的一次普通交流
    When 系统处理该次交流
    Then 不为这次交流调用软兜底生成
    And 不新增朋友或相识等软标签
    Examples:
      | 强关系 |
      | 师徒   |
      | 同门   |

  @RELATION_03
  Scenario: 旧软关系在出现强关系后保留并折叠
    Given 甲与乙先前已记录合格的相识关系
    And 后来得到合格的亲子关系
    When 用户查看默认图
    Then 默认突出亲子关系
    And 相识记录仍然保留
    When 用户展开该边的“更多”
    Then 可以查看旧相识关系及其依据

  @RELATION_04
  Scenario: 非主角之间也可以有软兜底
    Given 甲与乙都不是主角
    And 两人没有成立或未决的硬中关系
    And 原文有两人实际交流的依据
    And 兜底判断仅支持相识而不支持朋友
    When 系统生成软兜底并汇总
    Then 可以记录有来源章节与说明的相识关系
    And 不把相识提升为朋友

  @RELATION_05
  Scenario: 只有同章出现不能自动补边
    Given 甲与乙出现在同一章
    And 没有实际交流依据也没有其他合格关系
    When 系统汇总关系
    Then 不仅为连通图谱而给甲与乙补一条软关系

  @RELATION_06
  Scenario: 未决强关系先判断再找软兜底
    Given 甲与乙存在一条未决师徒候选和明确交流依据
    And 两人没有其他成立的硬中关系
    When 系统尚未完成该师徒候选的后续判断
    Then 不调用该人物对的软兜底生成
    When 定向补查明确否定师徒关系
    And 随后的兜底判断根据交流依据支持相识
    Then 先记录师徒被否定再记录有独立依据的相识
    And 不将师徒标签直接改写成相识

  @RELATION_07
  Scenario Outline: 未决或执行失败不是否定
    Given 甲与乙存在未决师徒候选和明确交流依据
    When 定向补查结果为“<结果>”
    Then 不将师徒候选记为已否定
    And 不触发该候选的否定后软兜底
    And 未决候选不进入默认图
    Examples:
      | 结果         |
      | 仍无法确认   |
      | 请求超时     |
      | 补查预算耗尽 |

  @RELATION_08
  Scenario: 否定一条候选但另有成立强关系
    Given 甲与乙有合格夫妻关系和未决师徒候选
    When 补查否定师徒候选
    Then 保留夫妻关系
    And 不因师徒被否定而新增软兜底

  @RELATION_09
  Scenario: 否定强关系后仍找不到合格兜底
    Given 甲与乙的唯一强候选已被否定
    And 兜底判断没有找到有依据的软关系
    When 系统汇总关系
    Then 不显示该强候选
    And 允许甲与乙之间没有关系边

  @RELATION_10
  Scenario: 相同关系跨章汇总保留来源
    Given 甲与乙在第一章和第二章都有同一类型的合格师徒关系
    When 系统汇总关系
    Then 甲与乙的师徒关系展示为一个标签
    And 该标签保留两个章节及各自的证据说明

  @RELATION_11
  Scenario: 情节动作不直接变成新关系类型
    Given 原文只描述甲向乙告别
    And 分析没有提供独立成立的关系判断
    When 系统处理该情节
    Then 不直接登记名为“一次告别”的关系类型

  @RELATION_12
  Scenario: 类型硬度不代替成立判断
    Given 一条亲子候选仍未决
    And 另一人物对的相识关系已经满足准入条件
    When 系统汇总关系
    Then 亲子候选不因属于硬关系而进入默认图
    And 相识关系不因属于软关系而被判为不可信

  @RELATION_13 @first_delivery
  Scenario: 有向关系保留双方角色与箭头方向
    Given 合格关系明确表示甲单恋乙
    When 系统汇总并展示该关系
    Then 关系保持从甲指向乙
    And 不生成乙单恋甲的结论
    And 不把单恋显示为双方恋爱

  @RELATION_14 @first_delivery
  Scenario: 同类型反向关系不按无向端点合并
    Given 甲到乙和乙到甲各有独立成立的同类型有向关系
    When 系统汇总关系
    Then 两个方向各自保留对应依据
    And 不仅因两端人物相同就丢掉其中一个方向
    And 不仅因同时存在两个方向就判定为冲突
