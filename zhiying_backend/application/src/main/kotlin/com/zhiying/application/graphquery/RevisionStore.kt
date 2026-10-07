// 结果版本存储端口：保存、读取结果版本，以及读取、切换某本书当前已发布的版本；由基础设施实现。
package com.zhiying.application.graphquery

import com.zhiying.domain.library.BookId
import com.zhiying.domain.revision.AnalysisRevision
import com.zhiying.domain.revision.RevisionId

/**
 * 结果版本存储。
 *
 * 约定（DESIGN §5.1、§5.2）：版本写入时不对外可见，发布才切换"当前版本"指针；发布在短事务里完成，
 * 模型调用期间不持有事务。分析编排完成后只需调用 [saveAndPublish]。
 */
interface RevisionStore {
    /** 保存一个版本但不发布；同 ID 已存在时报错（版本不可变）。 */
    fun save(revision: AnalysisRevision)

    /**
     * 把已保存的版本发布为该书当前版本。
     * 版本不存在或不属于该书时抛出 IllegalArgumentException。
     */
    fun publish(bookId: BookId, revision: RevisionId)

    /**
     * 仅当该书当前已发布版本等于 [expected]（null 表示尚无已发布版本）时才发布，否则不改动并返回 false。
     * 用于发布前确认输入没有被其他任务改变。
     */
    fun publishIfCurrent(bookId: BookId, revision: RevisionId, expected: RevisionId?): Boolean

    /** 保存并发布：先保存，再在短事务里切换指针。 */
    fun saveAndPublish(revision: AnalysisRevision) {
        save(revision)
        publish(revision.bookId, revision.id)
    }

    /** 该书当前已发布版本的 ID；尚无则为 null。 */
    fun publishedId(bookId: BookId): RevisionId?

    /** 读取该书当前已发布的版本；尚无则为 null。查询时固定读取一个版本，不会读到发布中的半成品。 */
    fun findPublished(bookId: BookId): AnalysisRevision?

    /** 按 ID 读取某个已保存的版本（无论是否已发布）；不存在则为 null。 */
    fun find(revision: RevisionId): AnalysisRevision?
}
