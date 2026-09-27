"""记忆的**向量那一路**：本地索引 + 与词面那一路的 RRF 融合（v0.50）。

为什么要有它——**实测说了算**（真模型 ``BAAI/bge-m3`` + 真实工作区，2026-09-27）：

| 查询 | 与 digest 块的余弦 |
| --- | --- |
| `回复风格`（词面也命中） | 0.621 |
| `我之前的回答是什么风格`（**词面搜不到**） | **0.615** |
| `碳酸锂价格走势`（无关） | 0.345 |
| `合唱团的排练时间安排`（无关） | 0.326 |

同义查询的余弦和逐字命中一样高，而无关查询干净地落在 0.35 以下——所以这一路不是
"理论上可能有用"，是**量出来的**（词面那条路的边界也量到了：见设计文档 §3.5.8）。

**为什么是本地小索引而不是 pgvector**：这一池子的量级是几份到几百份、几百 KB
（同 §3.5.3 那条"规模上不值得"的取舍），几千个 1024 维向量做一次全量余弦是毫秒级，
而**给记忆单开一张 pgvector 表**要付的是：一次迁移、一套按模型维度的分区管理、
以及"两池隔离"从"结构上不可能混"退化成"靠传对 key"。**在证明规模上值得之前不付
这个代价**——那句话是 v0.46 写的，今天依然照它办。

**索引放哪**：``mem_metadata/``（QwenPaw 的目录名，``memory_files._SKIP_DIRS`` 里
早就预留了）。它是**派生物**：删掉只是下次要重新嵌入一遍，不会丢任何记忆。

**三条不变量**（每一条都有对应用例）：

1. **索引可能落后一轮**（对齐挂在 worker 的空闲分支上，不在召回路径上）：所以查询时
   只认**当前确实存在**的块，落单的行直接丢掉——落后只会少召回，不会召回一个
   已经不存在的东西；
2. **模型换了就整份重建**：维度相同不等于向量空间兼容（架构 §6.4），拿旧模型的
   向量算余弦是没有意义的；
3. **嵌入只在块的内容真的变了时才发生**：判据是块指纹（路径 + 行号 + 正文的哈希），
   与 QwenPaw 的 chunk id 同一套口径——两路要对上同一个块，就得用同一套身份。
"""

from __future__ import annotations

import hashlib
import json
import logging
import os
from collections.abc import Callable, Sequence
from dataclasses import dataclass, replace
from pathlib import Path
from typing import Any

from app.core.exceptions import InvalidRequestError
from app.services import memory_files

logger = logging.getLogger(__name__)

__all__ = [
    "EmbeddingSource",
    "IndexRow",
    "VectorIndex",
    "chunk_digest",
    "load",
    "rrf_fuse",
    "save",
    "search",
    "search_hybrid",
    "sync",
]

#: 索引入口目录名。**必须在 ``memory_files._SKIP_DIRS`` 里**（否则索引文件会被
#: 当成记忆文件扫进来），有一条用例钉着这个一致性。
INDEX_DIR_NAME = "mem_metadata"
MANIFEST_NAME = "vectors.json"
MATRIX_NAME = "vectors.bin"

#: RRF 的常数与权重，照 QwenPaw：``weight/(k+rank)``、``k=60``、
#: 默认 ``vector_weight=0.7``（词面那一路拿剩下的 0.3）。
#:
#: 量纲说明：原始 RRF 分是 1/(60+rank) 这种量级（0.016 上下），直接用会让界面显示
#: 一串 0.01。乘一个常数**不改变排序**，只是让它落在和原来那个分数同一个数量级上。
RRF_K = 60.0
VECTOR_WEIGHT = 0.7
RRF_SCALE = 100.0

#: 余弦下限。实测（上面那张表）相关 0.61–0.68、无关 0.33–0.35，取中间偏保守的 0.45。
#: 它是**可以调的**（``memory.vector_min_score``）：样本只有 5 条，这个数是起点而不是
#: 定论；调低会把"沾点边"的也捞进来，调高会让同义查询重新掉出去。
DEFAULT_MIN_SCORE = 0.45


@dataclass(frozen=True, slots=True)
class EmbeddingSource:
    """向量那一路需要的东西：**模型身份 + 批量嵌入 + 一次最多发多少条**。

    用一个窄接口而不是整个 ``EmbeddingProvider``：记忆层只需要这三件事，
    而模型身份是必须的（换模型之后旧向量就是垃圾，见模块说明第 2 条）。
    """

    model_id: str
    dim: int
    embed: Callable[[Sequence[str]], list[list[float]]]
    max_batch: int = 32


def _numpy() -> Any:
    """惰性取 numpy。

    向量那一路是**可选**功能（默认关，见 ``memory.vector_enabled``），而 numpy 跟着
    ``parsers`` extra 走（pandas 本来就依赖它）。这样"裸 ``uv sync`` 的部署"照样能跑
    ——只要不打开这个开关。真打开了却拿不到 numpy 就**明确报错**（说清怎么装），
    而不是悄悄退回词面检索：那种"开了没反应"的坏法在这个仓库是被点过名的。
    """
    try:
        import numpy
    except ImportError as exc:  # pragma: no cover - 正常安装里到不了这里
        raise InvalidRequestError(
            "向量那一路需要 numpy：用 `uv sync --all-extras` 装，"
            "或者把 memory.vector_enabled 关掉（关着时记忆检索完全走词面那一路）"
        ) from exc
    return numpy


@dataclass(frozen=True, slots=True)
class IndexRow:
    """索引里的一行：**块的身份**（路径 + 行号）与它的内容指纹。"""

    path: str
    start_line: int
    end_line: int
    digest: str

    @property
    def key(self) -> tuple[str, int, int]:
        return (self.path, self.start_line, self.end_line)


@dataclass(frozen=True, slots=True)
class VectorIndex:
    """一份索引：模型身份 + 行 + 矩阵（每行是一个**已归一化**的向量）。

    存**归一化**之后的向量：余弦就退化成点积，查询时不必给每一行再算一次模长
    （那是几千次 sqrt）。原始向量是这个索引的输入，不是它的对外承诺。
    """

    model_id: str = ""
    dim: int = 0
    rows: tuple[IndexRow, ...] = ()
    matrix: Any = None

    @property
    def by_key(self) -> dict[tuple[str, int, int], int]:
        return {row.key: index for index, row in enumerate(self.rows)}


def chunk_digest(path: str, start_line: int, end_line: int, text: str) -> str:
    """一个块的指纹：**内容变了指纹就变**，所以"要不要重新嵌入"不用猜。

    照 QwenPaw 的 chunk id（``hash(path, start_line, end_line, text)``）——两路要把
    同一个块对上，就必须用同一套身份。
    """
    raw = f"{path}\0{start_line}\0{end_line}\0{text}".encode()
    return hashlib.sha256(raw).hexdigest()[:32]


def load(workspace: Path) -> VectorIndex:
    """读索引。**读不动就当空索引**（缺文件、JSON 坏了、二进制长度对不上）。

    坏掉的索引只该让向量那一路失效一次（下次对齐会重建它），不该让召回失败。
    """
    directory = workspace / INDEX_DIR_NAME
    try:
        manifest = json.loads((directory / MANIFEST_NAME).read_text(encoding="utf-8"))
        raw = (directory / MATRIX_NAME).read_bytes()
        dim = int(manifest["dim"])
        rows = tuple(
            IndexRow(
                path=str(item["path"]),
                start_line=int(item["start_line"]),
                end_line=int(item["end_line"]),
                digest=str(item["digest"]),
            )
            for item in manifest["rows"]
        )
        if not rows:
            return VectorIndex(model_id=str(manifest.get("model_id", "")), dim=dim)
        numpy = _numpy()
        expected = len(rows) * dim * 4
        if len(raw) != expected:
            logger.warning(
                "记忆向量索引的二进制长度对不上（%d ≠ %d），当空索引", len(raw), expected
            )
            return VectorIndex()
        matrix = numpy.frombuffer(raw, dtype=numpy.float32).reshape(len(rows), dim)
        return VectorIndex(
            model_id=str(manifest.get("model_id", "")), dim=dim, rows=rows, matrix=matrix
        )
    except (OSError, ValueError, KeyError, TypeError):
        return VectorIndex()


def save(workspace: Path, index: VectorIndex) -> None:
    """写索引：**先写临时文件再 replace**。

    半写坏的索引会让下一次读直接失败，而写入过程中断电/被 kill 是常态。
    """
    numpy = _numpy()
    directory = workspace / INDEX_DIR_NAME
    directory.mkdir(parents=True, exist_ok=True)
    matrix = index.matrix
    if matrix is None:
        matrix = numpy.zeros((0, max(index.dim, 0)), dtype=numpy.float32)
    manifest = {
        "model_id": index.model_id,
        "dim": index.dim,
        "rows": [
            {
                "path": row.path,
                "start_line": row.start_line,
                "end_line": row.end_line,
                "digest": row.digest,
            }
            for row in index.rows
        ],
    }
    _write_atomic(directory / MATRIX_NAME, matrix.astype(numpy.float32).tobytes(order="C"))
    _write_atomic(
        directory / MANIFEST_NAME, json.dumps(manifest, ensure_ascii=False).encode("utf-8")
    )


def _write_atomic(target: Path, payload: bytes) -> None:
    temp = target.with_name(f"{target.name}.tmp")
    # 按字节写：``write_text`` 在 Windows 上会把 ``\\n`` 翻成 ``\\r\\n``，而这里是二进制
    temp.write_bytes(payload)
    os.replace(temp, target)


def _normalize(vector: Sequence[float]) -> list[float]:
    total = sum(value * value for value in vector) ** 0.5
    if not total:
        return [0.0] * len(vector)
    return [value / total for value in vector]


def search(
    index: VectorIndex, vector: Sequence[float], *, limit: int, floor: float
) -> list[tuple[IndexRow, float]]:
    """余弦最近的若干行，**只回传达到下限的**。

    下限是这一路"不引入噪声"的唯一保证：词面那条路有覆盖率判据，向量这条路的判据
    就是它。没有它，任何查询都会返回"最像的几条"，包括噪声查询。
    """
    if not index.rows or index.matrix is None or index.dim <= 0:
        return []
    numpy = _numpy()
    query = numpy.asarray(_normalize(vector), dtype=numpy.float32)
    if float(numpy.linalg.norm(query)) == 0:
        return []
    sims = index.matrix @ query
    order = numpy.argsort(-sims)[: max(1, limit)]
    out: list[tuple[IndexRow, float]] = []
    for position in order:
        score = float(sims[int(position)])
        if score >= floor:
            out.append((index.rows[int(position)], score))
    return out


def sync(workspace: Path, source: EmbeddingSource, *, batch: int | None = None) -> dict[str, int]:
    """让索引与**当前块**对齐，返回 ``{"kept", "embedded", "dropped"}``。

    - 指纹没变的行**原样复用**（不重新嵌入）；
    - 新增/变了的那几块才嵌入（每批 ``source.max_batch`` 条）；
    - 消失的块丢掉；
    - 模型换了（``model_id`` 或 ``dim`` 不同）→ **整份重建**。
    """
    size = max(1, int(batch or source.max_batch or 32))
    current = memory_files.chunks_for_index(workspace)
    index = load(workspace)
    if index.model_id and (
        index.model_id != source.model_id or index.dim != source.dim
    ):
        logger.info(
            "嵌入模型换了（%s/%d → %s/%d），记忆向量索引整份重建",
            index.model_id,
            index.dim,
            source.model_id,
            source.dim,
        )
        index = VectorIndex(model_id=source.model_id, dim=source.dim)

    by_key = index.by_key
    keep_rows: list[IndexRow] = []
    keep_vectors: list[Any] = []
    todo: list[tuple[str, int, int, str]] = []
    for path, start_line, end_line, text in current:
        digest = chunk_digest(path, start_line, end_line, text)
        position = by_key.get((path, start_line, end_line))
        if (
            position is not None
            and index.rows[position].digest == digest
            and index.matrix is not None
        ):
            keep_rows.append(index.rows[position])
            keep_vectors.append(index.matrix[position])
            continue
        todo.append((path, start_line, end_line, text))

    dropped = len(index.rows) - len(keep_rows)
    if not todo and not dropped:
        return {"kept": len(keep_rows), "embedded": 0, "dropped": 0}

    fresh: list[list[float]] = []
    for start in range(0, len(todo), size):
        window = todo[start : start + size]
        fresh.extend(source.embed([text for _p, _s, _e, text in window]))

    numpy = _numpy()
    rows = [
        *keep_rows,
        *(
            IndexRow(path=p, start_line=s, end_line=e, digest=chunk_digest(p, s, e, t))
            for p, s, e, t in todo
        ),
    ]
    vectors = [*keep_vectors, *(_normalize(item) for item in fresh)]
    matrix = (
        numpy.asarray(vectors, dtype=numpy.float32)
        if vectors
        else numpy.zeros((0, max(source.dim, 0)), dtype=numpy.float32)
    )
    save(
        workspace,
        VectorIndex(
            model_id=source.model_id, dim=source.dim, rows=tuple(rows), matrix=matrix
        ),
    )
    return {"kept": len(keep_rows), "embedded": len(todo), "dropped": dropped}


def rrf_fuse(
    lexical: list[memory_files.MemoryMatch],
    vector: list[tuple[memory_files.MemoryMatch, float]],
) -> list[memory_files.MemoryMatch]:
    """RRF 融合：``Σ 权重/(k + 名次)``（照 QwenPaw）。

    **只在两路都非空时调用**（QwenPaw 的硬规定）：只有一路时按它自己的分数排——
    融合一个空列表会给出一个"看起来像分数"的排名分，而那会盖掉真实含义。
    """
    lexical_rank = {_key(hit): index + 1 for index, hit in enumerate(lexical)}
    vector_rank = {_key(hit): index + 1 for index, (hit, _score) in enumerate(vector)}
    merged: dict[tuple[str, int, int], memory_files.MemoryMatch] = {}
    for hit in lexical:
        merged[_key(hit)] = hit
    for hit, _score in vector:
        merged.setdefault(_key(hit), hit)
    out: list[memory_files.MemoryMatch] = []
    for key, hit in merged.items():
        score = 0.0
        if key in lexical_rank:
            score += (1.0 - VECTOR_WEIGHT) / (RRF_K + lexical_rank[key])
        if key in vector_rank:
            score += VECTOR_WEIGHT / (RRF_K + vector_rank[key])
        source = (
            "both"
            if key in lexical_rank and key in vector_rank
            else ("vector" if key in vector_rank else "text")
        )
        out.append(replace(hit, score=score * RRF_SCALE, source=source))
    out.sort(key=lambda item: (-item.score, item.path, item.start_line))
    return out


def _key(hit: memory_files.MemoryMatch) -> tuple[str, int, int]:
    return (hit.path, hit.start_line, hit.end_line)


def _cap_per_file(
    hits: list[memory_files.MemoryMatch], per_file: int
) -> list[memory_files.MemoryMatch]:
    """每个文件最多留 ``per_file`` 条（与词面那一路同一个理由：别让一份长笔记占满）。"""
    picked: list[memory_files.MemoryMatch] = []
    used: dict[str, int] = {}
    for hit in hits:
        if used.get(hit.path, 0) >= per_file:
            continue
        used[hit.path] = used.get(hit.path, 0) + 1
        picked.append(hit)
    return picked


def search_hybrid(
    workspace: Path,
    query: str,
    *,
    source: EmbeddingSource,
    limit: int = memory_files.DEFAULT_RECALL,
    per_file: int = memory_files.MAX_HITS_PER_FILE,
    min_score: float = DEFAULT_MIN_SCORE,
) -> list[memory_files.MemoryMatch]:
    """**词面 + 向量两路，RRF 融合**。

    - 词面那一路就是 ``memory_files.search``（有覆盖率判据，自己就完整）；
    - 向量那一路取余弦 ≥ ``min_score`` 的候选；
    - **只在两路都非空时融合**；否则按那一路自己的分数排（QwenPaw 的硬规定）；
    - 索引可能落后一轮，所以向量命中**只认当前确实存在的块**。
    """
    fuse_limit = max(limit * 4, 20)
    lexical = memory_files.search(workspace, query, limit=fuse_limit, per_file=per_file)
    index = load(workspace)
    vector: list[tuple[memory_files.MemoryMatch, float]] = []
    if index.rows:
        texts = {
            (path, start, end): text
            for path, start, end, text in memory_files.chunks_for_index(workspace)
        }
        for row, score in search(
            index, source.embed([query])[0], limit=fuse_limit, floor=min_score
        ):
            text = texts.get(row.key)
            if text is None:
                # 索引落后了：那一块已经被改掉或删掉了。**只少召回，不召回旧东西。**
                continue
            vector.append(
                (
                    memory_files.MemoryMatch(
                        text=memory_files.clip_hit(text),
                        path=row.path,
                        start_line=row.start_line,
                        end_line=row.end_line,
                        score=score,
                        coverage=0.0,
                        source="vector",
                    ),
                    score,
                )
            )
    capped = _cap_per_file([hit for hit, _score in vector], per_file)
    keep = {_key(hit) for hit in capped}
    vector = [(hit, score) for hit, score in vector if _key(hit) in keep]
    if not lexical and not vector:
        return []
    if not lexical:
        return [hit for hit, _score in vector][: max(1, limit)]
    if not vector:
        return lexical[: max(1, limit)]
    return _cap_per_file(rrf_fuse(lexical, vector), per_file)[: max(1, limit)]
