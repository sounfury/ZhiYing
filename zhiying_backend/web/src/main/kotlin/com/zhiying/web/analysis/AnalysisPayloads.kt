// 分析任务的响应载荷：任务快照、SSE 进度 / 完成事件、章抽取结果。字段名沿用旧后端（snake_case，chapter_id 为阅读序号），
// 与新设计冲突处以新设计为准（新增 revision_id、units_*、reused，没有旧的 reconcile_*）。
package com.zhiying.web.analysis

import com.zhiying.application.analyze.run.AnalysisEvent
import com.zhiying.application.analyze.run.AnalysisTask
import com.zhiying.application.analyze.run.ChapterRun
import com.zhiying.application.analyze.run.ChapterRunStatus
import com.zhiying.application.analyze.run.StoredExtraction
import com.zhiying.application.analyze.run.TaskStatus
import com.zhiying.domain.extraction.ChapterExtraction
import com.zhiying.domain.library.Chapter
import com.zhiying.domain.library.EvidenceRef
import com.zhiying.domain.relations.Direction
import com.zhiying.domain.relations.SemanticVerdict
import com.zhiying.domain.relations.TypeReference

/** 载荷构造；返回有序 Map，由 Jackson 序列化成 JSON。 */
internal object AnalysisPayloads {

    /** 章状态字符串：有警告的完成章为 partial（与旧后端一致），沿用的抽取视为 done。 */
    fun chapterStatus(c: ChapterRun): String = when (c.status) {
        ChapterRunStatus.PENDING -> "pending"
        ChapterRunStatus.RUNNING -> "running"
        ChapterRunStatus.DONE, ChapterRunStatus.REUSED -> if (c.warnings.isEmpty()) "done" else "partial"
        ChapterRunStatus.FAILED -> "failed"
        ChapterRunStatus.CANCELLED -> "cancelled"
    }

    /** 章计数：互斥，加起来不超过任务章数。 */
    private fun counts(t: AnalysisTask): Map<String, Int> = mapOf(
        "success_count" to t.chaptersDone,
        "failure_count" to t.chaptersFailed,
        "running_count" to t.chapters.count { it.status == ChapterRunStatus.RUNNING },
        "queued_count" to t.chapters.count { it.status == ChapterRunStatus.PENDING },
    )

    /** 用量字段。 */
    private fun usage(t: AnalysisTask): Map<String, Any?> = mapOf(
        "llm_requests" to t.usage.requests,
        "input_tokens" to t.usage.inputTokens,
        "output_tokens" to t.usage.outputTokens,
        "total_tokens" to t.usage.totalTokens,
    )

    /** 任务快照（页面刷新、断线重连用）；从未分析过传 null 得到 idle 快照。 */
    fun snapshot(t: AnalysisTask?): Map<String, Any?> {
        if (t == null) return mapOf("active" to false, "status" to "idle", "phase" to "idle", "chapters" to emptyList<Any>())
        return linkedMapOf(
            "task_id" to t.id.value,
            "kind" to t.kind.name.lowercase(),
            "active" to t.active,
            "status" to t.status.name.lowercase(),
            "phase" to t.phase.name.lowercase(),
            "total_chapters" to t.chapters.size,
            "started_at" to t.startedAt.toString(),
            "finished_at" to t.finishedAt?.toString(),
            "revision_id" to t.revisionId?.value,
            "message" to t.message,
            "chapters" to t.chapters.map(::chapterEntry),
        ) + counts(t) + usage(t)
    }

    /** 快照里的一章。 */
    private fun chapterEntry(c: ChapterRun): Map<String, Any?> = linkedMapOf(
        "chapter_id" to c.order,
        "title" to c.title,
        "status" to chapterStatus(c),
        "reused" to (c.status == ChapterRunStatus.REUSED),
        "units_done" to c.unitsDone,
        "units_total" to c.unitsTotal,
        "last_error" to (c.error ?: ""),
        "warnings" to c.warnings,
    )

    /** SSE progress 事件：章级变化带该章，阶段切换只有 phase 与计数。 */
    fun progress(e: AnalysisEvent): Map<String, Any?> {
        val t = e.task
        val base = linkedMapOf<String, Any?>()
        e.chapter?.let { c ->
            base["chapter_id"] = c.order
            base["status"] = chapterStatus(c)
            base["retry"] = false
            base["units_done"] = c.unitsDone
            base["units_total"] = c.unitsTotal
            c.error?.let { base["error"] = it }
        }
        base["done"] = t.chaptersDone
        base["total"] = t.chapters.size
        base["phase"] = t.phase.name.lowercase()
        return base + counts(t) + usage(t)
    }

    /** SSE done 事件：任务终态；失败章的原因逐章列出，published 表示本次是否产生了新的已发布结果。 */
    fun done(t: AnalysisTask?): Map<String, Any?> {
        if (t == null) {
            return mapOf("status" to "idle", "phase" to "idle", "chapters_done" to 0, "chapters_failed" to 0, "stopped" to false)
        }
        val failed = t.chapters.filter { it.status == ChapterRunStatus.FAILED }
        return linkedMapOf(
            "task_id" to t.id.value,
            "status" to if (t.status == TaskStatus.COMPLETED) "analyzed" else t.status.name.lowercase(),
            "phase" to t.phase.name.lowercase(),
            "stopped" to (t.status == TaskStatus.CANCELLED),
            "published" to (t.revisionId != null),
            "revision_id" to t.revisionId?.value,
            "message" to t.message,
            "chapters_done" to t.chaptersDone,
            "chapters_failed" to failed.size,
            "chapters_done_ids" to t.chapters.filter { it.succeeded }.map { it.order },
            "chapters_failed_ids" to failed.map { it.order },
            "chapters_partial_ids" to t.chapters.filter { it.succeeded && it.warnings.isNotEmpty() }.map { it.order },
            "errors" to failed.map { mapOf("chapter_id" to it.order, "error" to (it.error ?: "")) },
            "total" to t.chapters.size,
        ) + usage(t)
    }

    /**
     * 章抽取结果。[chapter] 用于把引文区间还原成原文；analysis_status 在读章有警告时为 partial。
     */
    fun extraction(order: Int, stored: StoredExtraction, chapter: Chapter): Map<String, Any?> {
        val x = stored.extraction
        return linkedMapOf(
            "chapter_id" to order,
            "extraction_id" to x.id.value,
            "task_id" to stored.taskId.value,
            "created_at" to stored.createdAt.toString(),
            "model" to x.provenance.model,
            "prompt_version" to x.provenance.promptVersion,
            "analysis_status" to if (stored.warnings.isEmpty()) "complete" else "partial",
            "warnings" to stored.warnings,
            "summary" to x.summary.text,
            "persons" to persons(x),
            "relations" to relations(x, chapter),
            "interactions" to x.interactions.map { i ->
                mapOf(
                    "id" to i.id.value,
                    "participants" to i.participants.map { it.key },
                    "description" to i.description,
                    "evidence" to evidence(i.evidence, chapter),
                )
            },
        )
    }

    /** 局部人物：名称（含种类与依据）与身份主张合并成一条。 */
    private fun persons(x: ChapterExtraction): List<Map<String, Any?>> = x.claims.map { claim ->
        linkedMapOf(
            "local_id" to claim.person.key,
            "existing_person_id" to claim.existing?.value,
            "basis" to claim.basis,
            "profile" to claim.profile,
            "gender" to claim.gender.name.lowercase(),
            "importance" to claim.importance?.name?.lowercase(),
            "names" to x.mentions.filter { it.person == claim.person }.map {
                mapOf("name" to it.name, "kind" to (it.stableKind?.name?.lowercase() ?: "context_only"), "basis" to it.basis)
            },
        )
    }

    /** 关系候选连同章内首次判断。 */
    private fun relations(x: ChapterExtraction, chapter: Chapter): List<Map<String, Any?>> = x.candidates.map { c ->
        val assessment = x.firstAssessmentOf(c.id)
        val verdict = assessment.verdict
        linkedMapOf(
            "id" to c.id.value,
            "source" to c.source.key,
            "target" to c.target.key,
            "type" to typeEntry(c.type),
            "description" to c.description,
            "evidence" to c.evidence.map { evidence(it, chapter) },
            "verdict" to when (verdict) {
                SemanticVerdict.Supported -> "supported"
                is SemanticVerdict.Undetermined -> "undetermined"
                SemanticVerdict.Refuted -> "refuted"
            },
            "undetermined_reason" to (verdict as? SemanticVerdict.Undetermined)?.reason?.name?.lowercase(),
            "assessment_basis" to assessment.basis,
        )
    }

    /** 类型引用：已知类型给 ID，新类型给建议内容。 */
    private fun typeEntry(type: TypeReference): Map<String, Any?> = when (type) {
        is TypeReference.Known -> mapOf("type_id" to type.id.value)
        is TypeReference.Proposed -> {
            val p = type.proposal
            val directed = p.direction as? Direction.Directed
            mapOf(
                "new_type" to mapOf(
                    "name" to p.name,
                    "definition" to p.definition,
                    "hardness" to p.hardness.name.lowercase(),
                    "directed" to (directed != null),
                    "source_role" to directed?.sourceRole,
                    "target_role" to directed?.targetRole,
                ),
            )
        }
    }

    /** 一项依据：说明加还原后的原文片段。 */
    private fun evidence(e: EvidenceRef, chapter: Chapter): Map<String, Any?> = mapOf(
        "note" to e.note,
        "quotes" to e.quotes.map { mapOf("start" to it.start, "end" to it.end, "text" to chapter.read(it)) },
    )
}
