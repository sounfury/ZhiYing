from __future__ import annotations

import unittest
from pathlib import Path
import sys

HERE = Path(__file__).resolve().parent
if str(HERE) not in sys.path:
    sys.path.insert(0, str(HERE))

from evaluate import RelationView, canonicalize_roles, classify_relation, kind_compatible


class RelationClassifierTests(unittest.TestCase):
    def test_friend_not_corrupted_by_third_party_reference(self):
        kind = classify_relation(
            "挚友",
            "友情",
            "乔文达皈依佛陀后与悉达多告别，但二人仍是青年时代朋友。",
            "朋友",
            "朋友",
        )
        self.assertEqual(kind, "friend")

    def test_explicit_respect_beats_teacher_word_in_raw_text(self):
        kind = classify_relation(
            "崇敬与信念认同",
            "精神",
            "视乔达摩为伟大导师，但明确并非师徒。",
            "崇敬者",
            "被崇敬者",
        )
        self.assertEqual(kind, "respect")

    def test_generic_teacher_disambiguates_love_art(self):
        kind = classify_relation(
            "师徒",
            "教学",
            "悉达多跟迦摩罗学习《爱经》和欢爱艺术。",
            "师傅",
            "徒弟",
        )
        self.assertEqual(kind, "skill_teacher_love")

    def test_generic_teacher_stays_formal_without_domain_context(self):
        kind = classify_relation(
            "师徒",
            "师承",
            "乔文达皈依佛陀并加入僧团。",
            "师傅",
            "徒弟",
        )
        self.assertEqual(kind, "formal_teacher")

    def test_teacher_roles_canonicalize_reversed_endpoints(self):
        rel = RelationView(
            chapter_id=12,
            source="prediction",
            index=1,
            person_a="乔文达",
            person_b="乔达摩",
            kind="formal_teacher",
            directed=True,
            role_a="弟子",
            role_b="宗师",
            label="师徒",
            category="师承",
            raw="",
            evidence_quote="",
        )
        self.assertEqual(canonicalize_roles(rel), ("乔达摩", "乔文达"))

    def test_mentor_does_not_equal_formal_teacher(self):
        self.assertFalse(kind_compatible("mentor", "formal_teacher"))
        self.assertTrue(kind_compatible("mentor", "respect"))


if __name__ == "__main__":
    unittest.main()
