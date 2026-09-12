from __future__ import annotations

import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
OUT = Path(__file__).resolve().parent
BOOK_DIR = ROOT / "workspace" / "bcb2958e-6863-4fcb-8ae2-17a3dab5fd8e"

CAST = {
    "悉达多": {"aliases": ["Siddhartha"], "importance": "main"},
    "乔文达": {"aliases": ["Govinda"], "importance": "main"},
    "乔达摩": {"aliases": ["佛陀", "世尊", "世尊佛陀", "释迦摩尼", "佛陀释迦摩尼", "Gotama"], "importance": "main"},
    "给孤独": {"aliases": ["给孤独长者", "Anathapindika"], "importance": "minor"},
    "迦摩罗": {"aliases": ["Kamala"], "importance": "main"},
    "迦摩施瓦弥": {"aliases": ["Kamaswami"], "importance": "supporting"},
    "瓦稣迪瓦": {"aliases": ["Vasudeva"], "importance": "main"},
    "小悉达多": {"aliases": ["悉达多之子", "Siddhartha's son"], "importance": "supporting"},
}


def ev(*quotes: str):
    return [{"quote": q} for q in quotes]


def rel(a, b, label, category, evidence, *, directed=False, subject_role="", object_role="", confidence="high", note=""):
    return {
        "person_a": a,
        "person_b": b,
        "label": label,
        "category": category,
        "directed": directed,
        "subject_role": subject_role,
        "object_role": object_role,
        "confidence": confidence,
        "evidence": evidence,
        "note": note,
    }


def forbid(a, b, labels, reason, evidence=None):
    return {
        "person_a": a,
        "person_b": b,
        "forbidden_labels": labels,
        "confidence": "high",
        "reason": reason,
        "evidence": evidence or [],
    }


CHAPTERS = [
    {
        "chapter_id": 1,
        "title": "婆罗门之子",
        "characters": [
            {"name": "悉达多", "presence": "active"},
            {"name": "乔文达", "presence": "active"},
        ],
        "required_relations": [
            rel("悉达多", "乔文达", "朋友", "友谊", ev("与他的好友，同为婆罗门之子的乔文达一道长大。"), note="自幼好友，同修辩论与冥想。"),
        ],
        "optional_relations": [
            rel("乔文达", "悉达多", "追随", "追随", ev("他要追随他，为人拥戴而神圣的悉达多。"), directed=True, subject_role="追随者", object_role="被追随者", confidence="medium", note="这是乔文达明确表达的长期追随意愿。"),
        ],
        "forbidden_relations": [],
        "identity_assertions": [],
    },
    {
        "chapter_id": 2,
        "title": "沙门",
        "characters": [
            {"name": "悉达多", "presence": "active"},
            {"name": "乔文达", "presence": "active"},
            {"name": "乔达摩", "presence": "mentioned"},
        ],
        "required_relations": [
            rel("悉达多", "乔文达", "同修挚友", "友谊", ev("乔文达，他的影子，和他生活在一起，也走了同样的路，付出同样的艰辛。"), note="二人在沙门处共同苦修近三年。"),
        ],
        "optional_relations": [],
        "forbidden_relations": [
            forbid("悉达多", "乔达摩", ["师徒", "弟子", "皈依"], "本章乔达摩仅以传闻出现，悉达多尚未与其见面。"),
        ],
        "identity_assertions": [
            {"canonical": "乔达摩", "aliases": ["佛陀"], "confidence": "high", "evidence": ev("乔达摩，佛陀的名字不断回响在青年耳畔。")},
        ],
    },
    {
        "chapter_id": 3,
        "title": "乔达摩",
        "characters": [
            {"name": "悉达多", "presence": "active"},
            {"name": "乔文达", "presence": "active"},
            {"name": "乔达摩", "presence": "active"},
            {"name": "给孤独", "presence": "mentioned"},
        ],
        "required_relations": [
            rel("悉达多", "乔文达", "朋友", "友谊", ev("乔文达，我的朋友，你已迈出步子，你选择了这条路。"), note="两人仍是朋友，但在本章选择不同道路。"),
            rel("乔达摩", "乔文达", "师徒", "师承", ev("乔文达听后已皈依佛陀。"), directed=True, subject_role="师傅", object_role="弟子", note="乔文达正式皈依并加入僧团。"),
            rel("给孤独", "乔达摩", "布施供养", "宗教", ev("该园由一位富庶的商人，也是世尊忠诚的追随者，给孤独[3]敬献。"), directed=True, subject_role="施主", object_role="受供养者", note="给孤独将祗园敬献给世尊。"),
        ],
        "optional_relations": [
            rel("悉达多", "乔达摩", "问法论道", "求道", ev("在路上，他遇见了世尊乔达摩。他恭敬地向世尊问安。"), directed=True, subject_role="求道者", object_role="被问道者", confidence="medium", note="悉达多与乔达摩当面论道，但没有皈依。"),
        ],
        "forbidden_relations": [
            forbid("悉达多", "乔达摩", ["师徒", "弟子", "皈依"], "悉达多明确表示朋友将留下而自己继续求道，不能因听法和敬仰推断为正式师徒。", ev("我的朋友将留在此处，他已皈依于您。我却要继续我的求道之路。")),
        ],
        "identity_assertions": [
            {"canonical": "乔达摩", "aliases": ["佛陀", "世尊"], "confidence": "high", "evidence": ev("此人就是佛陀。")},
        ],
    },
    {
        "chapter_id": 4,
        "title": "觉醒",
        "characters": [
            {"name": "悉达多", "presence": "active"},
            {"name": "乔达摩", "presence": "memory"},
            {"name": "乔文达", "presence": "memory"},
        ],
        "required_relations": [
            rel("乔达摩", "悉达多", "精神启发者", "求道", ev("他的最后一位恩师是神圣的世尊佛陀。"), directed=True, subject_role="精神启发者", object_role="受启发者", note="原文称“最后一位恩师”，但悉达多没有皈依，不能等价为正式师徒。"),
        ],
        "optional_relations": [],
        "forbidden_relations": [
            forbid("乔达摩", "悉达多", ["正式师徒", "皈依师徒", "僧团师徒"], "原文虽称恩师，但上一章已明确悉达多未皈依。", ev("但佛陀的法义也无法挽留他，折服他。")),
        ],
        "identity_assertions": [],
    },
    {
        "chapter_id": 5,
        "title": "迦摩罗",
        "characters": [
            {"name": "悉达多", "presence": "active"},
            {"name": "迦摩罗", "presence": "active"},
            {"name": "迦摩施瓦弥", "presence": "mentioned"},
            {"name": "乔文达", "presence": "dream_or_memory"},
            {"name": "乔达摩", "presence": "memory"},
        ],
        "required_relations": [
            rel("迦摩罗", "悉达多", "欢爱之术老师", "师承", ev("我想请求你做我的朋友和老师。因为对你所熟稔的艺术，我一无所知。", "但愿如此，我的老师。愿我的目光永远让你欢喜，愿我的好运一直因你而降临！"), directed=True, subject_role="老师", object_role="学生", note="关系限定为欢爱艺术上的老师/学生，不是宗教师承。"),
        ],
        "optional_relations": [
            rel("悉达多", "迦摩罗", "朋友", "友谊", ev("或许是的，”她轻声道，“如你所说，朋友。"), confidence="medium"),
            rel("悉达多", "迦摩罗", "相互吸引", "情感", ev("迦摩罗倾听着。她爱他的声音，爱他的目光。"), confidence="medium"),
        ],
        "forbidden_relations": [
            forbid("悉达多", "迦摩施瓦弥", ["商业伙伴", "雇佣", "师徒"], "本章只由迦摩罗引荐，悉达多尚未与迦摩施瓦弥正式会面。", ev("迦摩施瓦弥正在等你。")),
        ],
        "identity_assertions": [],
    },
    {
        "chapter_id": 6,
        "title": "尘世间",
        "characters": [
            {"name": "悉达多", "presence": "active"},
            {"name": "迦摩罗", "presence": "active"},
            {"name": "迦摩施瓦弥", "presence": "active"},
            {"name": "乔文达", "presence": "mentioned"},
            {"name": "乔达摩", "presence": "mentioned"},
        ],
        "required_relations": [
            rel("迦摩罗", "悉达多", "老师", "师承", ev("他成为她的学生、情人、朋友。"), directed=True, subject_role="老师", object_role="学生", note="上下文明确为欢爱艺术。"),
            rel("悉达多", "迦摩罗", "情人", "情感", ev("他成为她的学生、情人、朋友。"), note="同一对人物允许多标签并存。"),
            rel("悉达多", "迦摩罗", "朋友", "友谊", ev("他成为她的学生、情人、朋友。")),
            rel("悉达多", "迦摩施瓦弥", "商业共事", "合作", ev("在宅邸中住了不久，悉达多便开始分担迦摩施瓦弥的生意。"), note="不要求等价成主仆或正式师徒。"),
        ],
        "optional_relations": [
            rel("迦摩施瓦弥", "悉达多", "经商指导", "指导", ev("迦摩施瓦弥常谈论他的生意，向悉达多介绍他的货品、货栈，指导悉达多清算账目。"), directed=True, subject_role="指导者", object_role="学习者", confidence="medium"),
        ],
        "forbidden_relations": [],
        "identity_assertions": [
            {"canonical": "乔达摩", "aliases": ["世尊佛陀"], "confidence": "high", "evidence": ev("他就是乔达摩，世尊佛陀，那位宣法之人。")},
        ],
    },
    {
        "chapter_id": 7,
        "title": "轮回",
        "characters": [
            {"name": "悉达多", "presence": "active"},
            {"name": "迦摩罗", "presence": "active"},
            {"name": "迦摩施瓦弥", "presence": "active_or_mentioned"},
            {"name": "乔文达", "presence": "memory"},
            {"name": "乔达摩", "presence": "memory"},
        ],
        "required_relations": [
            rel("悉达多", "迦摩罗", "情人", "情感", ev("不久后，她发现同悉达多最后的交欢令她怀了身孕。"), note="明确存在持续的情人/性关系。"),
        ],
        "optional_relations": [
            rel("悉达多", "迦摩罗", "使其怀孕", "亲密关系事件", ev("不久后，她发现同悉达多最后的交欢令她怀了身孕。"), directed=True, subject_role="孩子生父", object_role="怀孕者", confidence="medium"),
            rel("悉达多", "迦摩施瓦弥", "商业关系", "合作", ev("迦摩施瓦弥唤人四处寻找，以为他落入盗匪之手。"), confidence="medium", note="关系延续自上一章，本章不再强制要求具体商业标签。"),
        ],
        "forbidden_relations": [],
        "identity_assertions": [],
    },
    {
        "chapter_id": 8,
        "title": "在河边",
        "characters": [
            {"name": "悉达多", "presence": "active"},
            {"name": "乔文达", "presence": "active"},
            {"name": "乔达摩", "presence": "mentioned"},
            {"name": "迦摩罗", "presence": "memory"},
            {"name": "迦摩施瓦弥", "presence": "memory"},
        ],
        "required_relations": [
            rel("悉达多", "乔文达", "青年时代朋友", "友谊", ev("很快，他认出他是自己青年时代的朋友，皈依佛陀的乔文达。")),
            rel("乔达摩", "乔文达", "师徒", "师承", ev("我是世尊乔达摩、佛陀释迦摩尼的弟子。"), directed=True, subject_role="师傅", object_role="弟子"),
        ],
        "optional_relations": [
            rel("乔文达", "悉达多", "守候", "照料", ev("我留下守候你，可我并不称职，我好像睡着了，疲惫战胜了我，尽管我本想守候你。"), directed=True, subject_role="守候者", object_role="被守候者", confidence="medium"),
        ],
        "forbidden_relations": [
            forbid("乔达摩", "悉达多", ["师徒", "弟子", "皈依"], "悉达多回忆的是相遇与告别，他没有成为乔达摩弟子。", ev("我又不得不告别佛陀及其伟大学说。")),
        ],
        "identity_assertions": [
            {"canonical": "乔达摩", "aliases": ["佛陀释迦摩尼", "世尊乔达摩"], "confidence": "high", "evidence": ev("我是世尊乔达摩、佛陀释迦摩尼的弟子。")},
        ],
    },
    {
        "chapter_id": 9,
        "title": "船夫",
        "characters": [
            {"name": "悉达多", "presence": "active"},
            {"name": "瓦稣迪瓦", "presence": "active"},
            {"name": "迦摩罗", "presence": "active"},
            {"name": "小悉达多", "presence": "active"},
            {"name": "乔达摩", "presence": "mentioned_or_memory"},
        ],
        "required_relations": [
            rel("悉达多", "瓦稣迪瓦", "朋友", "友谊", ev("留在这里吧，悉达多，我的朋友。"), note="两人随后共同生活、摆渡。"),
            rel("迦摩罗", "小悉达多", "母子", "亲属", ev("她听说乔达摩病危，就带着儿子小悉达多步行前往朝觐。"), directed=True, subject_role="母亲", object_role="儿子"),
            rel("悉达多", "小悉达多", "父子", "亲属", ev("他立即明白，这个有着和他相同面孔的孩子是他的儿子。", "他是你的儿子。"), directed=True, subject_role="父亲", object_role="儿子"),
            rel("悉达多", "迦摩罗", "昔日恋人", "情感", ev("她躺在悉达多的床上，曾经深爱她的悉达多守在一旁。如梦似幻，她含笑回望昔日的恋人。")),
            rel("迦摩罗", "乔达摩", "皈依信徒", "宗教", ev("她早已结束过去的生活，将花园赠予乔达摩僧团并皈依佛陀，成为朝圣者的施主和成员。"), directed=True, subject_role="皈依者", object_role="皈依对象"),
        ],
        "optional_relations": [
            rel("瓦稣迪瓦", "迦摩罗", "施救", "照料", ev("他迅速赶来，将迦摩罗抱到船里。"), directed=True, subject_role="施救者", object_role="被救者", confidence="medium"),
            rel("悉达多", "瓦稣迪瓦", "摆渡学艺", "指导", ev("悉达多留在船夫处学习摇橹。"), directed=False, confidence="medium", note="可接受“学徒/授艺”类描述，但不应升级为正式宗教师徒。"),
        ],
        "forbidden_relations": [
            forbid("瓦稣迪瓦", "悉达多", ["正式师徒", "宗教师徒", "皈依师徒"], "瓦稣迪瓦明确否认自己是导师，核心教导来自河水。", ev("你看，我不是导师，不擅言辞和思考。")),
        ],
        "identity_assertions": [],
    },
    {
        "chapter_id": 10,
        "title": "儿子",
        "characters": [
            {"name": "悉达多", "presence": "active"},
            {"name": "小悉达多", "presence": "active"},
            {"name": "瓦稣迪瓦", "presence": "active"},
            {"name": "迦摩罗", "presence": "memory"},
            {"name": "迦摩施瓦弥", "presence": "memory"},
        ],
        "required_relations": [
            rel("悉达多", "小悉达多", "父子", "亲属", ev("悉达多理解，儿子跟他不熟，不能像爱父亲那样爱他。"), directed=True, subject_role="父亲", object_role="儿子"),
            rel("悉达多", "瓦稣迪瓦", "朋友", "友谊", ev("当晚，瓦稣迪瓦把朋友叫到一边，同他交谈。"), note="上下文中“朋友”指悉达多。"),
        ],
        "optional_relations": [
            rel("小悉达多", "悉达多", "憎恨与反抗", "冲突", ev("我宁愿做扒手、杀人犯、下地狱，也不愿做你！我恨你。你不是我父亲，哪怕你做过我母亲十次的姘夫！"), directed=True, subject_role="反抗者", object_role="被反抗者", confidence="medium"),
            rel("瓦稣迪瓦", "小悉达多", "担忧", "关怀", ev("你的儿子让你担忧。我也担忧他。"), directed=True, subject_role="关心者", object_role="被关心者", confidence="medium"),
        ],
        "forbidden_relations": [],
        "identity_assertions": [],
    },
    {
        "chapter_id": 11,
        "title": "唵",
        "characters": [
            {"name": "悉达多", "presence": "active"},
            {"name": "瓦稣迪瓦", "presence": "active"},
            {"name": "乔文达", "presence": "vision_or_memory"},
            {"name": "迦摩罗", "presence": "vision_or_memory"},
        ],
        "required_relations": [
            rel("瓦稣迪瓦", "悉达多", "精神引导", "指导", ev("“你听见了河水的笑声。” 瓦稣迪瓦道，“但你尚未听见全部声音。我们倾听吧，你会听到更多。”"), directed=True, subject_role="引导者", object_role="受引导者", note="瓦稣迪瓦引导悉达多完成对河水‘整体之声’的领悟。"),
        ],
        "optional_relations": [
            rel("悉达多", "瓦稣迪瓦", "倾诉与倾听", "支持", ev("他说了许久。瓦稣迪瓦安静地倾听。"), directed=True, subject_role="倾诉者", object_role="倾听者", confidence="medium"),
        ],
        "forbidden_relations": [
            forbid("瓦稣迪瓦", "悉达多", ["正式师徒", "宗教师徒"], "这里是精神引导与共同倾听，不应把关系窄化为正式师徒。"),
        ],
        "identity_assertions": [],
    },
    {
        "chapter_id": 12,
        "title": "乔文达",
        "characters": [
            {"name": "悉达多", "presence": "active"},
            {"name": "乔文达", "presence": "active"},
            {"name": "乔达摩", "presence": "memory_or_reference"},
            {"name": "瓦稣迪瓦", "presence": "memory"},
            {"name": "迦摩罗", "presence": "memory_or_reference"},
        ],
        "required_relations": [
            rel("悉达多", "乔文达", "青年好友", "友谊", ev("他向年轻时的好友提出诸多问题，而悉达多则向他讲述自己的生活。")),
            rel("乔达摩", "乔文达", "师徒", "师承", ev("可敬的人，你已年迈，仍穿着乔达摩弟子的僧服。"), directed=True, subject_role="师傅", object_role="弟子"),
        ],
        "optional_relations": [
            rel("瓦稣迪瓦", "悉达多", "前辈与师长", "指导", ev("但我所学最多的，是跟随这条河和我的前辈，船夫瓦稣迪瓦。"), directed=True, subject_role="前辈/师长", object_role="受教者", confidence="medium", note="悉达多回顾瓦稣迪瓦，属于回忆关系。"),
            rel("乔文达", "悉达多", "敬爱与敬意", "情感", ev("如同火焰点燃他心中最深的爱和最谦卑的敬意。"), directed=True, subject_role="敬爱者", object_role="被敬爱者", confidence="medium"),
        ],
        "forbidden_relations": [
            forbid("乔达摩", "悉达多", ["师徒", "弟子", "皈依"], "悉达多尊敬并认同乔达摩，但始终没有成为其弟子。", ev("我知道，我同乔达摩信念一致。")),
        ],
        "identity_assertions": [],
    },
]


def main() -> None:
    manifest = {
        "schema_version": "1.0",
        "book": "悉达多",
        "author": "赫尔曼·黑塞",
        "book_id": "bcb2958e-6863-4fcb-8ae2-17a3dab5fd8e",
        "scope": {"included_chapters": list(range(1, 13)), "excluded_chapters": [13], "excluded_reason": "第13章为译后记，include_in_analysis=false"},
        "scoring_policy": {
            "required_relations": "计入关系召回与语义准确率",
            "optional_relations": "命中可加分，漏掉不扣召回；预测为这些关系不算幻觉",
            "forbidden_relations": "命中视为高价值错误，计入hallucinated_relation_rate / semantic_error_rate",
            "identity_assertions": "用于人物同一性与别名合并评分",
            "evidence": "所有Gold evidence quote必须在对应章节正文中精确出现",
        },
        "canonical_cast": [{"name": name, **data} for name, data in CAST.items()],
        "global_identity_assertions": [
            {"canonical": "乔达摩", "aliases": ["佛陀", "世尊", "世尊佛陀", "释迦摩尼", "佛陀释迦摩尼", "Gotama"], "must_merge": True},
        ],
        "chapter_files": [f"chapter_{i:03d}.json" for i in range(1, 13)],
    }
    (OUT / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    for chapter in CHAPTERS:
        cid = chapter["chapter_id"]
        payload = {
            "schema_version": "1.0",
            "book": "悉达多",
            "chapter_id": cid,
            "title": chapter["title"],
            "source_chapter_file": str((BOOK_DIR / "chapters" / f"chapter_{cid:03d}.json").relative_to(ROOT)).replace("\\", "/"),
            "characters": chapter["characters"],
            "required_relations": chapter["required_relations"],
            "optional_relations": chapter["optional_relations"],
            "forbidden_relations": chapter["forbidden_relations"],
            "identity_assertions": chapter["identity_assertions"],
        }
        (OUT / f"chapter_{cid:03d}.json").write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    print(f"wrote {len(CHAPTERS)} chapter gold files + manifest -> {OUT}")


if __name__ == "__main__":
    main()
