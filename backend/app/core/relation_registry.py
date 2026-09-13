"""注册表操作：类型标识由服务端分配，不以中文标签为主键。"""
import hashlib
import json

from app.domain.relation_types import RelationDefinition, RelationDescriptor, RelationRegistry
from app.models.ledger import Relation


def descriptor(value) -> dict:
    """按 RelationDescriptor 的字段序提取对象的 descriptor 字典。"""
    return {key: getattr(value, key) for key in RelationDescriptor.model_fields}


def register(registry: RelationRegistry, value: RelationDescriptor, source="learned") -> RelationDefinition:
    """
    注册 descriptor：相同定义直接复用，否则按内容哈希生成 rel_<digest> 标识。

    Raises:
        ValueError: 生成的 predicate 与已有定义冲突。
    """
    data = descriptor(value)
    for item in registry.definitions:
        if descriptor(item) == data:
            return item
    digest = hashlib.sha256(json.dumps(data, ensure_ascii=False, sort_keys=True).encode()).hexdigest()[:24]
    item = RelationDefinition(**data, predicate=f"rel_{digest}", source=source)
    existing = registry.get(item.predicate)
    if existing is not None:
        raise ValueError("关系标识冲突")
    registry.definitions.append(item)
    registry.version += 1
    return item


def apply_definition(relation: Relation, definition: RelationDefinition, reverse=False):
    """把归一定义套到关系上：校验方向一致，reverse 时交换端点，最后标记 normalization_status=resolved。"""
    if relation.directed != definition.directed:
        raise ValueError("不能将有向关系归一成无向关系，或反之")
    if reverse:
        if not definition.directed:
            raise ValueError("无向关系不能反转角色")
        relation.person_a, relation.person_b = relation.person_b, relation.person_a
    for key, value in descriptor(definition).items():
        setattr(relation, key, value)
    relation.predicate = definition.predicate
    relation.normalization_status = "resolved"
