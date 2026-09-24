---
name: kylab-office-export
description: Turn a finished result into a real file the user can send on — .docx or .pdf for a report, .xlsx for a table, .pptx for a deck. Use this Skill when the user asks for "一份报告", "导出成 Word / Excel / PPT", "生成文件", "做个表格给我", "整理成文档", "给我一份能发出去的", or when the deliverable is clearly meant to leave the chat (a report for someone else, a spreadsheet to work in, slides to present). Do not use it for material that is only meant to be read in the conversation — answer inline instead.
summary: 把结果导出成能直接发出去的 Word、Excel、PPT 或 PDF
---

# Export a deliverable into a real file

Three tools, one per shape. Pick by **what the user will do with it**, not by which
sounds closest: a table that gets sorted belongs in `.xlsx` even if it was discussed as
part of a report, and slides meant to be presented belong in `.pptx` even if the text was
written as prose.

| Tool | Output | Use when | Do not |
| --- | --- | --- | --- |
| `export_document` | `.docx` / `.pdf` | The result is something to **read or forward**: a report, a memo, a set of instructions. Markdown in (headings `#`, bullets `-`, tables `\| a \| b \|`), a real file out | Ask for `.docx` and `.pdf` in one call — one call, one file; make two calls if both are wanted |
| `export_table` | `.xlsx` | The result is **rows and columns**: checklists, comparisons, per-item figures. First row is the header | Put a table in a document and call it done — a table inside `.docx` can't be sorted or summed |
| `export_deck` | `.pptx` | The result is meant to be **presented**: a walkthrough, a proposal, an outline. One page = one point | Paste whole paragraphs into a slide — that is a document wearing slides' clothes; use `export_document` instead |

## Where the file goes

**You do not choose a place, and you do not choose a knowledge base.** Just export:

- If the conversation is attached to a workspace, the file is written into that
  workspace's directory — the user opens their project folder and it is there.
- Otherwise it lands in this conversation's own file area, and it shows up as a card
  under the step, with a download button.

The tool result tells you which of the two happened (`saved_to`). Say that in your
reply, in the user's terms ("已放进工作区「XX」") — not the raw path.

**Filing it into a knowledge base is a separate thing the user asks for.** Export does
not do it, and neither should you: their library is something they organise. When they
say "存进知识库" / "放进资料库" / "以后还能查到", call `ingest_artifact` with the
`artifact_id` from the export step and the library they named. If they did not name one
and you cannot tell which, **ask** — or list the libraries with `list_knowledge_bases`
and ask which. Do not pick one for them, and do not file it "just in case".

## Workflow

1. **Finish the content first.** These tools do not research or compose anything — they
   take what you already have and put it in a file. If the material is not settled yet,
   settle it in the conversation first.
2. **Choose the filename deliberately.** It is what the user sees, so make it descriptive
   in their language (`近视防控随访方案.docx`, not `output.docx`). The extension picks the
   format — it is not decoration.
3. **Export, then say what you produced and where it went.**
4. **Only if they ask, file it into a library** — with `ingest_artifact`, using the
   library they named or confirmed.

## Content conventions

- **Markdown subset only**: `#`–`####` headings, paragraphs, `-`/`*` bullets, `1.`
  numbered items, and pipe tables. Footnotes, embedded HTML, and task lists are **not**
  rendered — they will show up as literal text. Don't use them.
- Numbers in `export_table` should be numbers, not strings (`4`, not `"4"`). A column of
  text-numbers can't be summed, and the user will think the file is broken.
- Keep slide bullets short. A slide is a speaking aid; the detail belongs in a document.

## Limits (so you don't waste a call discovering them)

| Limit | Value |
| --- | --- |
| Document body | 200,000 characters |
| Table | 5,000 rows × 100 columns |
| Deck | 60 slides × 20 bullets per slide |

Exceeding one returns an error naming the limit — split the material instead of retrying.

## What these tools do not do

- **They do not check how it looks.** The files are structurally correct and open in
  Word / Excel / PowerPoint, but nothing renders a page image to verify layout. Don't
  claim a document "looks good" — describe what is in it.
- **They do not convert back.** Reading a `.docx` / `.xlsx` / `.pptx` / `.pdf` is
  handled by the ingest pipeline: upload it with `upload_document` and it becomes
  searchable text, like any other document.
- **They do not edit an existing file.** Each call creates a new file. To revise, produce
  a new version and say so.
- **They do not overwrite.** If a file of the same name is already in the workspace
  directory, the new one is saved next to it as `名字 (2).docx` — the user's existing file
  is never replaced.
