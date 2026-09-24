---
name: kylab-delegate
description: Hand a self-contained piece of work to a sub-agent and get its conclusion back — "把这批资料读完告诉我", "分头查一下这几个问题", "帮我把这几篇的结论汇总成一句话". Use `spawn_subagent` when the work means grinding through a batch of material to produce one answer, so this conversation's context stays usable. Do not use it for one lookup, or for work that needs this conversation's history.
summary: 把成批资料交给子 Agent 读完，只把结论带回这段对话
---

# Delegate a batch of work

`spawn_subagent` runs a separate agent with its own context and returns its conclusion.
The point is not parallelism — it is **keeping this conversation's context clean**: reading
six documents to produce one sentence should not cost six documents of context here.

## Use it when

- The task is **self-contained**: a question, plus what to base it on.
- The work is **reading-heavy**: several documents, a whole library, comparing many items.
- You want a **conclusion**, not the material: "这几篇的结论一致吗", "把要点汇总成三条".

## Do not use it when

- One `search` or one `web_fetch` answers it. It is slower and it re-does the setup.
- The task needs **this** conversation's history — the sub-agent cannot see it. Anything
  it must know has to be written into the task text.
- You need the raw passages. The sub-agent returns a conclusion plus its sources; if you
  need to quote the原文 yourself, search here instead.
- The work needs its own sub-agents. It has none — one level only, by design.

## Writing the task text

The task is the **whole brief**, because nobody else can see this conversation:

- What to answer, in one sentence ("这批文档里，随访间隔是怎么规定的？").
- What to look at (library names, the documents, the query terms to try).
- What shape the answer should be ("结论 + 依据的文档名").
- Any constraint the user stated ("只看 2024 年之后的").

A vague task ("帮我看看这个") buys a vague answer at full price.

## After it returns

- **Report the conclusion and its sources.** The sub-agent's sources come back with it —
  keep them, they are still the basis for what you tell the user.
- **Say if it stopped early.** If it ran out of steps or time, its answer says so. Do not
  present a partial result as complete; either say it was partial, or check the remaining
  part yourself.
- **Do not chain five of them.** Each one is a full round of work. Two or three is a lot.

## Pitfalls

- **Giving it a task that needs your context.** "接着刚才那个" means nothing to it.
- **Treating its summary as verified evidence.** It read the material and summarized;
  for a claim that matters, get the source from it (or search here) and quote that.
- **Delegating the easy part.** If you already know what to do, do it.

## Verification

Before spawning: could I write this task in a way a stranger with library access could
answer? If not, the task is not self-contained yet. After it returns: did I keep its
sources, and did I say whether it finished?
