# language: en
@confirmed @first_delivery @prd_3_1 @prd_4_4 @prd_5_7_5
Feature: 团体归属与关系正交
  团体分区已纳入 Kotlin 重构首批交付。
  团体判断结果由可控测试输入提供，布局可读性的量化目标仍待专项制定。

  @GROUP_01
  Scenario: 朋友关系不直接建立朋友势力
    Given 甲与乙是朋友且分别属于东山学校与南湖学校
    When 系统生成团体分区
    Then 甲与乙保留各自的学校归属
    And 朋友关系作为两人之间的边保留
    And 不仅因朋友关系创建名为朋友的势力

  @GROUP_02
  Scenario: 一个人可以保留多种团体归属
    Given 甲同时明确属于东山学校和城北教会
    When 系统展示人物归属
    Then 两种归属都被保留
    And 布局通过主归属落块并以标记或块交界表达次要归属
    And 不要求用户手动修正归属才能出图

  @GROUP_03
  Scenario: 单次同场不自动成为团体
    Given 甲与乙只有一次同场且无稳定团体归属依据
    When 系统分析团体
    Then 不仅凭此次同场建立一个团体

  @GROUP_04
  Scenario: 百人全景优先采用团体分区
    Given 合格结果包含 120 个可见人物且具有明确团体归属
    When 用户打开全景图
    Then 默认以团体分区组织人物
    And 不仅展示 20 人子集就宣称完成百人全景

  @GROUP_05
  Scenario: 无明确团体时尝试分区并标明最终降级
    Given 百人图没有明确团体且按共现或阶段也无法形成分区
    When 系统生成可浏览视图
    Then 降级为强过滤子集与辅助布局
    And 界面明确标示已经降级
