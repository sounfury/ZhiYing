# language: en
@confirmed @prd_5_7
Feature: 可解释的图谱浏览与导出
  验收使用确定的合格章结果，不依赖实时模型生成。

  @GRAPH_01
  Scenario: 人物出现次数按章节去重
    Given 甲只在第一章的人物列表中出现但正文提及十次
    And 乙在第一章和第二章的人物列表中都出现
    And 两人均无硬关系且未被聚焦
    When 用户使用默认最少出现 2 章的过滤阈值
    Then 甲因出现 1 章被过滤
    And 乙因出现 2 章被保留
    And 界面展示被过滤人数且允许查看被过滤名单

  @GRAPH_02
  Scenario: 硬关系人物低于阈值也保留
    Given 甲只出现于一章但参与合格亲子关系
    When 用户使用最少出现 2 章的过滤阈值
    Then 甲仍被保留

  @GRAPH_03
  Scenario: 聚焦低频人物并恢复全局
    Given 甲因出现章节数不足被过滤
    And 甲与乙有合格关系而丙与甲没有直接关系
    When 用户搜索甲并进入聚焦
    Then 甲无视出现阈值显示为中心人物
    And 乙作为甲的直接关系人物显示
    And 丙在聚焦视图中隐藏
    When 用户退出聚焦
    Then 恢复进入聚焦前的全局过滤视图
    And 聚焦时隐藏的人物没有被删除

  @GRAPH_04
  Scenario: 展示关系依据
    Given 一条合格关系包含来源章节、非空解释和合法引文
    When 用户查看该关系详情
    Then 展示该关系的类型、来源章节、解释与引文

  @GRAPH_05
  Scenario: 切换渲染样式不改变数据与聚焦
    Given 用户已在纯文字模式聚焦甲
    When 用户切换为头像框模式
    Then 仍然聚焦甲
    And 人物、关系与布局保持一致

  @EXPORT_01
  Scenario: 导出当前画布 PNG
    Given 用户正在查看一个已应用过滤和渲染样式的图谱
    When 用户导出 PNG
    Then 图片呈现当前画布
    And 包含分析范围说明与关系图例

  @EXPORT_02
  Scenario: 导出图数据 JSON
    Given 用户正在查看包含节点、关系和证据的图谱
    When 用户导出 JSON
    Then 导出数据包含当前图的节点、关系与证据
    And 各关系端点能对应到导出的节点
