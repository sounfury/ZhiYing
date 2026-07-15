"""
EPUB Parser — 解析 EPUB → (BookMeta, list[Chapter])。

per-spine-item 分层降级切章：
  1. 内部多个 <h1>/<h2> heading → 按 heading 切
  2. 正文匹配「第X回/Chapter N」多处 → 正则切
  3. 以上均不匹配 → 整 item 一章

切完后统一过滤短章、重编号，并按标题启发设置 include_in_analysis。
不写盘——落盘由调用方通过 Filestore 完成。
"""
from __future__ import annotations

import re
import statistics
import warnings
from pathlib import Path
from typing import Optional

import ebooklib
from ebooklib import epub
from bs4 import BeautifulSoup

# EPUB 内嵌的 XHTML 会被 lxml HTML parser 解析，产生无害警告
try:
    from bs4 import XMLParsedAsHTMLWarning
    warnings.filterwarnings("ignore", category=XMLParsedAsHTMLWarning)
except ImportError:
    pass

from app.errors import epub_parse_error
from app.models.book import BookMeta, Chapter

# ── 正则 ──

_CHINESE_CHAPTER_RE = re.compile(
    r"第[\d一二三四五六七八九十百千]+[章回节卷]"
)
_ENGLISH_CHAPTER_RE = re.compile(
    r"Chapter\s+\d+",
    re.IGNORECASE,
)
_ENGLISH_WORD_RE = re.compile(r"[a-zA-Z]+")
_HEADING_MARKER = "\x00HD\x00"

# 非正文标题启发（导读/序/年表/附录等 → include_in_analysis=false）
# 吃不准时默认 true，见 _include_in_analysis()
_NON_BODY_TITLE_RE = re.compile(
    r"("
    r"导读|序言|前言|译序|再版序|目录|版权|出版说明|"
    r"年表|大事记|附录|注释|参考文献|作者简介|译后记|后记|^跋$|跋言|"
    r"preface|foreword|contents|chronology|appendix|acknowledg|"
    r"copyright|translator'?s\s+note"
    r")",
    re.IGNORECASE,
)
# 正文分节强信号
_BODY_TITLE_RE = re.compile(
    r"("
    r"第[\d一二三四五六七八九十百千]+[章回节部卷集]|"
    r"Chapter\s+\d+|"
    r"Part\s+\d+"
    r")",
    re.IGNORECASE,
)


# ── 入口 ──


def parse_epub(
    file_path: str | Path,
    *,
    min_chapter_words: int = 200,
) -> tuple[BookMeta, list[Chapter]]:
    """
    解析 EPUB 文件，返回 (BookMeta, Chapter[])。

    纯内存操作，不写盘。
    """
    file_path = Path(file_path)

    try:
        book = epub.read_epub(str(file_path))
    except Exception as e:
        raise epub_parse_error(f"无法读取 EPUB 文件: {e}")

    # ── 元数据 ──
    title, author = _extract_metadata(book)

    # ── spine items ──
    spine_items = _get_spine_items(book)
    if not spine_items:
        raise epub_parse_error("EPUB spine 为空，无法提取内容")

    # ── per-item 分层切章 ──
    raw_chapters: list[tuple[str, str, str]] = []  # (title, cleaned_text, source_href)
    for item in spine_items:
        try:
            raw_html = item.get_content()
            if isinstance(raw_html, bytes):
                raw_html = raw_html.decode("utf-8", errors="ignore")
        except Exception:
            continue
        source_href = item.get_name() or getattr(item, "id", "") or ""
        chapters = _process_spine_item(raw_html, source_href)
        raw_chapters.extend(chapters)

    # ── 字数统计 ──
    counted: list[tuple[str, str, str, int]] = [
        (t, text, href, _count_words(text)) for t, text, href in raw_chapters
    ]

    # ── 短章过滤 ──
    filtered = [
        (t, text, href, wc)
        for t, text, href, wc in counted
        if wc >= min_chapter_words
    ]

    # ── 零章 guard ──
    if not filtered:
        raise epub_parse_error(
            f"无有效章节：所有章节低于 {min_chapter_words} 字阈值"
        )

    # ── 重编号 + 创建 Chapter（含 include_in_analysis）──
    chapters: list[Chapter] = []
    for i, (t, text, href, wc) in enumerate(filtered, 1):
        chapters.append(
            Chapter(
                chapter_id=i,
                title=t,
                order=i,
                content=text,
                word_count=wc,
                source_href=href,
                include_in_analysis=_include_in_analysis(t),
            )
        )

    # ── profiling ──
    word_counts = [ch.word_count for ch in chapters]
    analysis_count = sum(1 for ch in chapters if ch.include_in_analysis)
    meta = BookMeta(
        title=title,
        author=author,
        source_file=file_path.name,
        total_chapters=len(chapters),
        total_words=sum(word_counts),
        max_chapter_words=max(word_counts),
        median_chapter_words=int(statistics.median(word_counts)),
        analysis_chapter_count=analysis_count,
    )

    return meta, chapters


# ── 元数据提取 ──


def _extract_metadata(book: epub.EpubBook) -> tuple[str, str]:
    """从 OPF metadata 读 dc:title / dc:creator。"""
    title = ""
    author = ""

    titles = book.get_metadata("DC", "title")
    if titles:
        title = titles[0][0]

    creators = book.get_metadata("DC", "creator")
    if creators:
        author = creators[0][0]

    return title, author


# ── spine items ──


def _get_spine_items(book: epub.EpubBook) -> list[epub.EpubItem]:
    """提取 spine 中的文档类型 item。"""
    items: list[epub.EpubItem] = []
    for entry in book.spine:
        item_ref = entry[0] if isinstance(entry, tuple) else entry
        if isinstance(item_ref, str):
            item = book.get_item_with_id(item_ref)
        else:
            item = item_ref
        if item is not None and item.get_type() == ebooklib.ITEM_DOCUMENT:
            items.append(item)
    return items


# ── per-item 处理 ──


def _process_spine_item(
    raw_html: str,
    source_href: str,
) -> list[tuple[str, str, str]]:
    """
    处理单个 spine item，返回 list of (title, cleaned_text, source_href)。

    分层降级：heading → 正则 → 整体一章。
    """
    soup = BeautifulSoup(raw_html, "lxml")

    # 移除 script / style
    for tag in soup.find_all(["script", "style"]):
        tag.decompose()

    body = soup.body or soup

    # ── Layer 1: heading 切分（2+ heading → 按 heading 切）──
    headings = body.find_all(["h1", "h2"])
    if len(headings) >= 2:
        return _split_by_headings(body, headings, source_href)

    # ── 清洗为纯文本 ──
    full_text = _clean_html_to_text(body)
    if not full_text.strip():
        return []

    # ── 恰好 1 个 heading → heading 为标题，整 item 一章 ──
    # 不走正则：正文里的「第X章」是引用，不是章节边界
    if len(headings) == 1:
        title = headings[0].get_text(strip=True) or _extract_title_from_soup(soup)
        return [(title, full_text, source_href)]

    # ── Layer 2: 正则切分（0 heading 时才尝试）──
    regex_chunks = _try_regex_split(full_text)
    if regex_chunks is not None:
        return [(t, text, source_href) for t, text in regex_chunks]

    # ── Layer 3: 整体一章 ──
    title = _extract_title_from_soup(soup)
    return [(title, full_text, source_href)]


# ── heading 切分 ──


def _split_by_headings(
    body,
    headings,
    source_href: str,
) -> list[tuple[str, str, str]]:
    """按 h1/h2 heading 位置切分。返回 list of (title, text, source_href)。"""
    # 保存标题
    titles = [h.get_text(strip=True) for h in headings]

    # 用标记替换 heading 内容（作为分割点）
    for i, h in enumerate(headings):
        h.string = f"{_HEADING_MARKER}{i}\x00"

    full_text = body.get_text()
    parts = re.split(r"\x00HD\x00\d+\x00", full_text)
    # parts[0] 是第一个 heading 之前的内容，跳过

    result: list[tuple[str, str, str]] = []
    for i, title in enumerate(titles):
        text = parts[i + 1] if i + 1 < len(parts) else ""
        text = _normalize_text(text)
        if text:
            result.append((title or "未命名", text, source_href))

    return result


# ── 正则切分 ──


def _try_regex_split(text: str) -> Optional[list[tuple[str, str]]]:
    """
    尝试用章节正则切分。
    返回 list of (title, chunk_text)（2+ 处匹配时），否则 None。
    """
    for pattern in (_CHINESE_CHAPTER_RE, _ENGLISH_CHAPTER_RE):
        matches = list(pattern.finditer(text))
        if len(matches) >= 2:
            result: list[tuple[str, str]] = []
            for i, m in enumerate(matches):
                start = m.start()
                end = matches[i + 1].start() if i + 1 < len(matches) else len(text)
                chunk_text = text[start:end].strip()
                title = m.group().strip()
                result.append((title, chunk_text))
            return result
    return None


# ── HTML 清洗 ──


def _clean_html_to_text(body) -> str:
    """
    将 BeautifulSoup body 转为纯文本：
    - 去标签
    - <p>/<br>/<div> 转 \\n\\n
    - 解码 HTML 实体（BeautifulSoup 自动处理）
    """
    for tag in body.find_all(["p", "div", "br"]):
        tag.append("\n\n")

    text = body.get_text()
    return _normalize_text(text)


def _normalize_text(text: str) -> str:
    """归一化文本：压缩多余空行。"""
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip()


# ── 标题提取 ──


def _extract_title_from_soup(soup) -> str:
    """从 <title> 标签提取标题；没有则返回 '未命名'。"""
    title_tag = soup.find("title")
    if title_tag:
        t = title_tag.get_text(strip=True)
        if t:
            return t
    return "未命名"


# ── 分析纳入判定 ──


def _include_in_analysis(title: str) -> bool:
    """
    根据标题启发是否纳入 AI 分析。

    - 命中正文分节模式 → true
    - 命中导读/序/年表/附录等 → false
    - 其余默认 true（宁肯多分析，别漏正文）
    """
    t = (title or "").strip()
    if not t:
        return True
    if _BODY_TITLE_RE.search(t):
        return True
    if _NON_BODY_TITLE_RE.search(t):
        return False
    return True


# ── 字数统计 ──


def _count_words(text: str) -> int:
    """
    字数统计：去空白标点后中文字符按字计 + 英文按空格分词计。
    """
    if not text:
        return 0

    # 中文字符（CJK Unified Ideographs + Extension A）
    chinese_count = sum(
        1
        for c in text
        if "\u4e00" <= c <= "\u9fff" or "\u3400" <= c <= "\u4dbf"
    )

    # 英文词（连续字母序列）
    english_words = _ENGLISH_WORD_RE.findall(text)

    return chinese_count + len(english_words)
