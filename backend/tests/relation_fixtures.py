"""测试用完整语义描述生成器，不参与运行时代码。"""
from app.domain.relation_types import seed_registry
from app.core.relation_registry import descriptor


def relation_fields(label):
    definition = next(d for d in seed_registry().definitions if label == d.label or label in d.aliases)
    return dict(descriptor(definition), predicate=definition.predicate,
                normalization_status="resolved", raw_relation=f"甲与乙的关系是{definition.label}")
