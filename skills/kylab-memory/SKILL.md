---
name: kylab-memory
description: Keep the user's standing facts in one profile, correct them in place, and check what changed — their name and how to address them, stable preferences, project goals and constraints, and "上次那条不是这么说的", "记一下", "忘掉那条". Use `remember` when something is worth still knowing next week, `remember(..., replaces=...)` to correct an entry, `forget` to drop one, and `recall` only to see what a past entry said. Not for documents (that is the knowledge base) and not for one-off details from this conversation.
summary: 维护一份用户档案：记一条、就地更正、忘掉一条、查以前是怎么写的
---

# 一份档案，三种动作

This is not a log and not a pile of files. It is **one profile** (`PROFILE.md`) with four
fixed sections — who the user is, what they care about, what they are working on, and the
tools around them. It is injected into **every turn**, in full, so anything you write there
is a permanent tax on every future message. Write accordingly.

Two pools, and mixing them is the main way to get this wrong:

| | User profile (`remember` / `forget` / `recall`) | Knowledge base (`search`) |
| --- | --- | --- |
| What it holds | what the **user told you** — who they are, preferences, decisions, constraints | what **documents say** — with sources, pages, headings |
| Can it be wrong? | yes, and it gets corrected | it is what the file says |
| Do you edit it | yes — that is the point | no — it is evidence |

If a claim needs to be checkable, it belongs in the knowledge base. If it is a working
agreement ("他喜欢先看结论", "这个项目用 PG 不用 MySQL"), it belongs in the profile.

## `remember` — one fact, in the user's own words

Write **one reusable fact, one line**, in the user's own language:

- How they are addressed, and anything they call themselves.
- How they like answers: what to lead with, what to leave out.
- Settled decisions with the reason: "用 pgvector 而不是 FAISS，因为要跟元数据同库查".
- Tools and environment they stated: hosts, paths, versions.
- Lessons that cost time: "这份数据每月 5 号才更新，别提前拉".

**Do not** write: today's task details, conversation summaries, anything you inferred
rather than were told, or a fact that will be stale next week. Anything longer than a
sentence belongs in `AGENTS.md` or a note.

**Never** write passwords, tokens, keys, or identity numbers — even if the user pastes
them. The profile is inside every turn's context. Say you are not keeping that.

## Correcting: `replaces`, not delete-then-write

The user says "不是 A，是 B". Do it in **one call**:

```
remember(content="用户要求先给结论再列依据", replaces="用户要求尽量简短")
```

The old line goes to a change log and stays recoverable, so a misfire costs the user one
click. Two calls (forget, then remember) leave a window where the profile says **nothing**
about it at all — and if they ask in that window, the answer is wrong.

**There is no "keep both".** The old version is not kept next to the new one for the user
to prune later; it is *replaced*. Writing the new line without `replaces` leaves both, and
then the profile contradicts itself forever.

## `forget` — and hand the undo to the user

`forget(topic)` drops one entry, keeping the old value in the change log. **You cannot
restore it yourself** — if the user changes their mind, tell them it can be restored from
the memory page and let them click it. Do not write the old line back by hand.

If `topic` matches several entries, the tool refuses and lists them: ask which one instead
of guessing. Deleting the wrong fact is not worth saving a question.

## `recall` — what did it used to say

The profile is already in front of you; `recall` does **not** search it. What it searches
is the **change log**: what was changed, when, and what the previous wording was.

Call it when the user says something like "上次不是这么说的", "我什么时候改的", or when you
need the exact earlier text before correcting it.

If it returns nothing, that means the change log genuinely has nothing on it — say so, and
ask. Do not reconstruct a plausible past.

## When you write it

Say so, in one short line, quoting the tool's receipt: "记下了：……" / "改成：……". The user
should be able to catch a wrong entry the moment it is created — that is the cheapest
moment to fix it.

## Pitfalls

- **The profile is not evidence.** It means "this is what was said", not "this is true
  now". If the user contradicts it, the user wins — say so rather than arguing from it.
- **Do not recall to fill space.** The change log is not an answer to "what do you know
  about me" — that is the profile, which you already have.
- **One line at a time.** If you need two lines to say it, it is two facts or it is not a
  fact.
