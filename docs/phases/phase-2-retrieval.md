# Phase 2 — Retrieval & Grounded Chat

**Status:** done 2026-08-20

## Decisions worth remembering

**Fusion happens in JavaScript, retrieval in SQL.** Both halves run as CTEs in a single round
trip, but Reciprocal Rank Fusion runs in application code. Cosine distance and `ts_rank_cd`
are not on comparable scales and normalizing between them is guesswork; RRF only needs
positions, so it sidesteps the problem entirely.

**The org filter is deliberately absent from the retrieval SQL.** RLS applies it. A bug in
this query cannot leak across tenants, which is a stronger guarantee than a `WHERE` clause
that someone might forget.

**The answer is buffered before it is shown.** Tokens are collected from the provider, then
replayed to the client. Streaming straight through would mean the refusal check and the
citation check happen after the user has already read the text — and both can only run once
the model has finished.

**An uncited answer is a refusal.** Fluent text with no `[n]` marker violates the grounding
contract, so it is replaced with the tenant's no-answer message. Tested.

## The gate threshold is measured, not guessed

The relevance gate started at 0.35 and **could never fire**. Measured against
`gemini-embedding-001` at 768 dimensions on a support corpus:

| Query type | Best-passage cosine similarity |
|---|---|
| On-topic ("How long is the warranty?") | 0.721 – 0.786 |
| Off-topic ("What is the capital of France?") | 0.526 – 0.576 |

Cosine similarity has a high floor here — unrelated text scores well above zero — so the
threshold moved to **0.65**, inside the gap. The effect is directly observable: the same
out-of-scope question went from a 2376ms round trip costing $0.000188 to a 694ms refusal
costing $0.000000.

The general lesson: a similarity threshold copied from a tutorial is meaningless. It has to be
measured against the actual model, dimension count, and corpus.

## A real bug this phase caught

Citations were naming the wrong section. The cause was not the prompt — it was the chunker.
`tailWords` was asked for 90 tokens of overlap while the handbook's sections were about 65
tokens each, so it returned the *entire* previous chunk. Every chunk therefore began with the
whole preceding section, which:

- roughly doubled storage and embedding spend,
- made retrieval return near-duplicate chunks,
- and labelled each chunk with the wrong heading, so citations pointed at the wrong section
  while quoting text that genuinely did contain the answer.

Two fixes, both tested: overlap is now capped at half a chunk, and it never crosses a heading
boundary — overlap exists to rescue a fact split by the token budget inside one section, not
to blend distinct sections. Citation precision improved immediately: the SKU question went
from citing two passages (one wrong) to citing exactly one, correctly.

Worth noting this was invisible to the unit tests, which used paragraph text with no headings
and a token budget larger than the overlap. It only showed up in a live end-to-end run.

## Deferred

- Reranking. Decide from Phase 5's eval scorecard, not in advance.
- Conversation history in the prompt — each question is currently answered independently.
- Public widget-key auth for `/v1/chat` (origin allowlist, rate limits) lands in Phase 3.
