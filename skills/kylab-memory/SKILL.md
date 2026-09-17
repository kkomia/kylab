---
name: kylab-memory
description: Keep what is durable and recall what was said before — the user's standing preferences, decisions that were settled, constraints that keep coming up, or "上次说到哪了", "我之前说过", "记一下". Use `recall` before asking the user to repeat themselves, and `remember` when something is worth still knowing next week. Not for documents (that is the knowledge base) and not for one-off facts from this conversation.
---

# Remember, and recall

Two different pools, and mixing them is the main way to get this wrong:

| | Memory (`recall` / `remember`) | Knowledge base (`search`) |
| --- | --- | --- |
| What it holds | what the **user told you** — preferences, decisions, constraints | what **documents say** — with sources, pages, headings |
| Can it be wrong? | yes, and it goes stale | it is what the file says |
| Do you edit it | yes, freely | no — it is evidence |

If a claim needs to be checkable, it belongs in the knowledge base. If it is a working
agreement ("他喜欢先看结论", "这个项目用 PG 不用 MySQL"), it belongs in memory.

## `recall` — before you ask

Call it when the user references something you should already know:

- "上次那个方案", "我之前说过", "接着上次", "还是按老规矩" → `recall` first.
- Before asking a question the user may have already answered in an earlier session.
- Before `remember` — so you do not write the same thing twice.

If it returns nothing, that is information: say you do not have it, and ask. Do not
reconstruct a plausible past.

## `remember` — one fact per call

Write **one reusable fact**, in one line, in the user's own language:

- Standings: how they like answers, what they always want excluded, working hours.
- Settled decisions and their reason: "用 pgvector 而不是 FAISS，因为要跟元数据同库查".
- Tool/environment facts they stated: hosts, paths, aliases, accounts they use.
- Lessons that cost time: "这份数据每月 5 号才更新，别提前拉".

**Do not** write: today's task details, conversation summaries, anything you inferred
rather than were told, or a fact that will be irrelevant next week. Anything longer than a
sentence belongs in a note (`create_note`) — memory is injected into every turn, so a long
one is a tax on every future message.

**Never** write passwords, tokens, keys, or private identifiers, even if the user pastes
them. Say you are not keeping that.

## When you write it

Say so, in one short line: "记下了：……". The user should be able to correct a memory the
moment it is created — that is the only cheap moment to fix it.

## Pitfalls

- **Memory is not evidence.** It means "this is what was said", not "this is true now".
  If the user contradicts it, the user wins — say so rather than arguing from memory.
- **Do not recall to fill space.** A `recall` that returns unrelated fragments, quoted as
  if relevant, is worse than no recall.
- **Do not silently overwrite a habit.** If the user changes their mind ("以后别给我列
  那么多选项"), write the new one; the old and new will both be there for them to prune.

## Verification

Before answering from memory, check the recall actually came back with something about
**this** question. Before writing, check it is one sentence, durable, and something the
user would expect you to still know next week.
