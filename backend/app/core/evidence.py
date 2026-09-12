"""确定性证据定位。原句存在不等于语义成立，定位成功仍保持待确认。"""
from app.models.ledger import Relation


def locate_evidence(relation: Relation, content: str) -> bool:
    evidence = relation.evidence
    evidence.start = evidence.end = None
    relation.status = "pending"
    quote = evidence.quote
    if not quote.strip():
        evidence.quote_verified = False
        relation.verification_reason = "缺少原文证据"
        return False
    start = content.find(quote)
    evidence.quote_verified = start >= 0
    if start < 0:
        relation.verification_reason = "引用未在本章正文精确匹配，请补充连续原句"
        return False
    if content.find(quote, start + 1) >= 0:
        relation.verification_reason = "引用出现多次，请补充上下文以唯一定位"
        return False
    evidence.start, evidence.end = start, start + len(quote)
    relation.verification_reason = "原文已定位，等待语义验证"
    return True
