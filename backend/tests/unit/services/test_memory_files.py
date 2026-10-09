"""记忆文件层（v0.14 三期；档案制见 ``docs/设计/记忆档案-设计-v0.1.md``）。

镜像同构：``app/services/memory_files.py`` → 本文件。

**这一层 2026-10-09 瘦身到只剩"常量与纯函数"**，所以用例也跟着收成一条主线：
``parse_frontmatter`` 拆得对、坏 frontmatter 不抛错（技能 / 插件 / 命令 / 市场那五处
都拿它读自己的 ``SKILL.md``，坏一个就整列表 500 是最难查的一类故障）。

``CORE_FILES`` 那张清单不在这里钉——它的关系（人设清单必须是核心文件的一部分、
``MEMORY.md`` 只在清单里不在注入清单）在 ``tests/unit/services/test_prompt.py`` 里，
与"铺什么 / 注入什么"放在一起看才说得清。

## 被删掉的用例与理由

读文件与扫工作区那一半随 ``GET /memory/files/{path}`` 下了架（记忆页上那节只读的人设
文件整块删掉），而它当时的读者**只剩这些用例**——按"零生产读者"一并删：

- **路径越界**（``safe_path`` 那一族：``../`` / 盘符 / NTFS 数据流 / 非 .md / 控制字符）——
  边界随读路径一起没了，留着用例只会钉一个不存在的入口；
- **扫描与状态读数**（``stats`` 的份数 / 跳过派生物目录 / 上次改动）与
  **分类**（``classify``：核心 / daily / digest / other）——``GET /memory`` 状态里的
  文件读数更早就退了场（v0.57 起状态只报条目），分类只服务那份列表；
- **读原文与元信息**（``read_file`` / ``describe``：逐字还原、404、元信息与正文同源）——
  同一条读路径。

**"逐字读、坏 frontmatter 不抛错"这两条口径没有随它们消失**，只是换了住处：
技能那一层（``services/skills.py``）自己钉着同一批坑。
"""

from __future__ import annotations

from app.services.memory_files import parse_frontmatter


def test_parse_frontmatter_splits_meta_and_body() -> None:
    meta, body = parse_frontmatter("---\nsummary: 一句话\ntags: [a, b]\n---\n\n正文\n")
    assert meta == {"summary": "一句话", "tags": ["a", "b"]}
    assert body.strip() == "正文"


def test_parse_frontmatter_survives_broken_yaml() -> None:
    """YAML 坏了**不能抛错**：用户正是进来修它的，此时打不开等于把人关在门外。
    退回"没有 frontmatter"、正文原样返回（含那段 ``---``）。"""
    text = "---\nsummary: '没闭合的引号\n---\n\n正文\n"
    meta, body = parse_frontmatter(text)
    assert meta == {}
    assert body == text


def test_parse_frontmatter_without_block() -> None:
    meta, body = parse_frontmatter("# 标题\n")
    assert meta == {}
    assert body == "# 标题\n"


def test_parse_frontmatter_treats_a_non_mapping_as_empty() -> None:
    """frontmatter 里写成一个标量或列表时按"没有"处理（调用方拿到的永远是 ``dict``）。"""
    meta, body = parse_frontmatter("---\n- a\n- b\n---\n\n正文\n")
    assert meta == {}
    assert body.strip() == "正文"
