"""
FactionResolver 测试 — 势力块的确定性后处理。

覆盖：近重名合并 / 切片过滤（防剧透）/ 主势力打分 / 邻居传播兜底 /
未归属兜底块 / 环形排序 / needs_review。
"""
from __future__ import annotations

from app.core.faction_resolver import UNASSIGNED_ID, resolve_factions
from app.models.faction import Faction, FactionBook, FactionKind, Membership
from app.models.graph import GraphEdge, GraphTag


def _edge(a: str, b: str, type_: str = "朋友", tier: str = "soft", score: float = 1.0):
    return GraphEdge(
        person_a=a,
        person_b=b,
        tags=[GraphTag(type=type_, tier=tier, directed=False, display_score=score)],
    )


def _faction(fid: str, name: str, kind: FactionKind, members, aliases=None):
    return Faction(
        faction_id=fid,
        canonical_name=name,
        kind=kind,
        aliases=aliases or [],
        members=[
            Membership(person_id=pid, chapter_ids=chs, confidence=conf)
            for pid, chs, conf in members
        ],
    )


def test_basic_blocks_and_membership():
    book = FactionBook(
        factions=[
            _faction("f001", "克朗戈斯学院", FactionKind.SCHOOL,
                     [("p1", [1], 0.9), ("p2", [1], 0.9)]),
            _faction("f002", "代达勒斯家", FactionKind.FAMILY,
                     [("p3", [1, 2], 0.9)]),
        ]
    )
    r = resolve_factions(book, {"p1", "p2", "p3"}, {1, 2}, [_edge("p1", "p2")])

    assert {f.faction_id for f in r.factions} == {"f001", "f002"}
    assert r.primary == {"p1": "f001", "p2": "f001", "p3": "f002"}
    assert not r.inferred


def test_slice_filter_hides_later_factions():
    """第 5 章才出现的大学块，在前 2 章切片里整块消失（防剧透）。"""
    book = FactionBook(
        factions=[
            _faction("f001", "克朗戈斯学院", FactionKind.SCHOOL, [("p1", [1, 2], 0.9)]),
            _faction("f002", "都柏林大学", FactionKind.SCHOOL, [("p2", [5], 0.9)]),
        ]
    )
    r = resolve_factions(book, {"p1", "p2"}, {1, 2}, [])

    ids = {f.faction_id for f in r.factions}
    assert "f001" in ids
    assert "f002" not in ids
    # 大学块的人落进未归属，而不是凭空消失
    assert UNASSIGNED_ID in ids
    assert r.factions[-1].member_ids == ["p2"]


def test_invisible_members_dropped():
    book = FactionBook(
        factions=[
            _faction("f001", "教会", FactionKind.RELIGIOUS,
                     [("p1", [1], 0.9), ("p_hidden", [1], 0.9)]),
        ]
    )
    r = resolve_factions(book, {"p1"}, {1}, [])

    assert r.factions[0].all_member_ids == ["p1"]
    assert "p_hidden" not in r.primary


def test_primary_pick_prefers_family_over_movement():
    """同 confidence 时 kind 权重决定落块：family(1.0) > movement(0.7)。"""
    book = FactionBook(
        factions=[
            _faction("f001", "民族主义圈", FactionKind.MOVEMENT, [("p1", [1], 0.9)]),
            _faction("f002", "代达勒斯家", FactionKind.FAMILY, [("p1", [1], 0.9)]),
        ]
    )
    r = resolve_factions(book, {"p1"}, {1}, [])

    assert r.primary["p1"] == "f002"
    # 多归属仍完整记录，供侧栏展示
    assert set(r.node_factions["p1"]) == {"f001", "f002"}


def test_chapter_overlap_outweighs_kind_weight():
    """活跃章命中多 → 即使 kind 权重低也能拿下主势力。"""
    book = FactionBook(
        factions=[
            _faction("f001", "代达勒斯家", FactionKind.FAMILY, [("p1", [1], 0.9)]),
            _faction("f002", "民族主义圈", FactionKind.MOVEMENT,
                     [("p1", [1, 2, 3, 4], 0.9)]),
        ]
    )
    r = resolve_factions(book, {"p1"}, {1, 2, 3, 4}, [])

    assert r.primary["p1"] == "f002"


def test_propagation_assigns_unlabeled_neighbor():
    """无显式归属者按邻居加权多数票归块，并标记为 inferred。"""
    book = FactionBook(
        factions=[
            _faction("f001", "克朗戈斯学院", FactionKind.SCHOOL,
                     [("p1", [1], 0.9), ("p2", [1], 0.9)]),
        ]
    )
    # p3 无归属，但与 p1/p2 有边 → 应被传播进 f001
    edges = [_edge("p1", "p3"), _edge("p2", "p3")]
    r = resolve_factions(book, {"p1", "p2", "p3"}, {1}, edges)

    assert r.primary["p3"] == "f001"
    assert r.inferred == {"p3"}
    assert "p3" in r.factions[0].member_ids
    # 传播来的人不算显式归属
    assert "p3" not in r.node_factions


def test_propagation_respects_edge_weight():
    """两个块各有一个邻居时，边权重（display_score）大的胜出。"""
    book = FactionBook(
        factions=[
            _faction("f001", "A校", FactionKind.SCHOOL, [("p1", [1], 0.9)]),
            _faction("f002", "B校", FactionKind.SCHOOL, [("p2", [1], 0.9)]),
        ]
    )
    edges = [
        _edge("p1", "p3", "相识", "soft", 1.0),
        _edge("p2", "p3", "亲子", "hard", 8.0),
    ]
    r = resolve_factions(book, {"p1", "p2", "p3"}, {1}, edges)

    assert r.primary["p3"] == "f002"


def test_isolated_person_goes_to_unassigned():
    book = FactionBook(
        factions=[_faction("f001", "克朗戈斯学院", FactionKind.SCHOOL, [("p1", [1], 0.9)])]
    )
    r = resolve_factions(book, {"p1", "loner"}, {1}, [])

    last = r.factions[-1]
    assert last.faction_id == UNASSIGNED_ID
    assert last.member_ids == ["loner"]
    assert last.inferred is True


def test_merge_near_duplicate_names():
    """LLM 跨批次造出的近重名块要并掉（前缀 / 别名两条路径）。"""
    book = FactionBook(
        factions=[
            _faction("f001", "克朗戈斯伍德公学", FactionKind.SCHOOL, [("p1", [1], 0.9)]),
            _faction("f002", "克朗戈斯", FactionKind.SCHOOL, [("p2", [1], 0.9)]),
            _faction("f003", "别的学校", FactionKind.SCHOOL, [("p3", [1], 0.9)],
                     aliases=["克朗戈斯伍德公学"]),
        ]
    )
    r = resolve_factions(book, {"p1", "p2", "p3"}, {1}, [])

    assert len(r.factions) == 1
    assert set(r.factions[0].all_member_ids) == {"p1", "p2", "p3"}


def test_short_names_not_over_merged():
    """短名不走前缀合并，避免「家」把不相关的块并掉。"""
    book = FactionBook(
        factions=[
            _faction("f001", "贾府", FactionKind.FAMILY, [("p1", [1], 0.9)]),
            _faction("f002", "甄府", FactionKind.FAMILY, [("p2", [1], 0.9)]),
        ]
    )
    r = resolve_factions(book, {"p1", "p2"}, {1}, [])

    assert len(r.factions) == 2


def test_ring_order_puts_linked_blocks_adjacent():
    """块间连线多的应排相邻：A—B 有 3 条跨块边，C 与谁都不连 → C 不夹在 A、B 之间。"""
    book = FactionBook(
        factions=[
            _faction("f001", "A校", FactionKind.SCHOOL,
                     [("a1", [1], 0.9), ("a2", [1], 0.9), ("a3", [1], 0.9)]),
            _faction("f002", "C会", FactionKind.RELIGIOUS,
                     [("c1", [1], 0.9), ("c2", [1], 0.9)]),
            _faction("f003", "B家", FactionKind.FAMILY,
                     [("b1", [1], 0.9), ("b2", [1], 0.9), ("b3", [1], 0.9)]),
        ]
    )
    edges = [_edge("a1", "b1"), _edge("a2", "b2"), _edge("a3", "b3")]
    r = resolve_factions(book, {"a1", "a2", "a3", "b1", "b2", "b3", "c1", "c2"}, {1}, edges)

    order = [f.faction_id for f in r.factions if f.faction_id != UNASSIGNED_ID]
    ia, ib = order.index("f001"), order.index("f003")
    assert abs(ia - ib) == 1, f"A 与 B 应相邻，实际顺序 {order}"


def test_needs_review_flags_block_internal_loner():
    """
    块内与任何同伴都无连线 → 归属可疑（≥3 人的块才判）。

    注意 outsider 必须自带归属：否则邻居传播会把它吸进 f001，
    odd 就有了同块邻居，不再算孤立——那是算法的正确行为。
    """
    book = FactionBook(
        factions=[
            _faction("f001", "都柏林市井", FactionKind.OTHER,
                     [("p1", [1], 0.9), ("p2", [1], 0.9), ("odd", [1], 0.9)]),
            _faction("f002", "别处", FactionKind.OTHER, [("outsider", [1], 0.9)]),
        ]
    )
    r = resolve_factions(book, {"p1", "p2", "odd", "outsider"}, {1},
                         [_edge("p1", "p2"), _edge("odd", "outsider")])

    market = next(f for f in r.factions if f.faction_id == "f001")
    assert market.needs_review == ["odd"]


def test_small_block_not_flagged_for_review():
    book = FactionBook(
        factions=[
            _faction("f001", "两人组", FactionKind.OTHER,
                     [("p1", [1], 0.9), ("p2", [1], 0.9)]),
        ]
    )
    r = resolve_factions(book, {"p1", "p2"}, {1}, [])

    assert r.factions[0].needs_review == []


def test_empty_faction_book_yields_single_unassigned_block():
    r = resolve_factions(FactionBook(), {"p1", "p2"}, {1}, [_edge("p1", "p2")])

    assert len(r.factions) == 1
    assert r.factions[0].faction_id == UNASSIGNED_ID
    assert r.factions[0].member_ids == ["p1", "p2"]
    # 未归属者的 primary 指向兜底块（否则前端「只看未归属」会筛出空图）
    assert r.primary == {"p1": UNASSIGNED_ID, "p2": UNASSIGNED_ID}
    # 但显式归属仍为空——他们确实没抽出归属
    assert not r.node_factions


def test_unassigned_primary_matches_block_for_filtering():
    """节点 primary 必须与所在块 id 对齐，按块筛选才不会漏人。"""
    book = FactionBook(
        factions=[_faction("f001", "克朗戈斯学院", FactionKind.SCHOOL, [("p1", [1], 0.9)])]
    )
    r = resolve_factions(book, {"p1", "loner"}, {1}, [])

    for f in r.factions:
        for pid in f.member_ids:
            assert r.primary[pid] == f.faction_id, f"{pid} 的 primary 与所在块不一致"


def test_membership_without_chapter_ids_is_always_active():
    """chapter_ids 为空 = 全程活跃，不被切片过滤掉。"""
    book = FactionBook(
        factions=[_faction("f001", "某组织", FactionKind.ORGANIZATION, [("p1", [], 0.9)])]
    )
    r = resolve_factions(book, {"p1"}, {7}, [])

    assert r.primary["p1"] == "f001"
