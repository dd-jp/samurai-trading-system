# 61 — Five candidate topics vs the safest max-profit path

**Status:** RESEARCHED (2026-09-17) — **compatibility ranking, measures nothing.** Parent: [`~/Documents/Obsidian/research/samurai-five-topics-fit-2026-09-17-report.md`](/Users/ddjp/Documents/Obsidian/research/samurai-five-topics-fit-2026-09-17-report.md). Raws: `-web-raw.md`, `-opus-raw.md` (pipeline filename; analysis is cheap-model, not Opus).

**Question (David):** which of Medallion, momentum, swing, candle bull/bear, vector DB would *add* to Samurai on the **safest max-profit** path.

**Label convention.** **[verified]** = read from a repo artifact or a fetched page this pass. **[derived]** = arithmetic on verified inputs. **[inferred]** = a reading not stated in those words. **[assumed]** = modelling choice. Unlabelled prose is argument.

This doc **selects nothing and proposes no Stage 2 submission.** It is a grill against the live product (ADR-0014–0018), in the same family as [`56-awesome-systematic-trading-compatibility-grill.md`](56-awesome-systematic-trading-compatibility-grill.md). Doc 56 already scored momentum-as-coded; this pass asks whether *any* of five popular topics should consume a D4 trial slot.

---

## 1. What “add” and “safest max profit” mean here

The live product is **intraday, flat-by-close, equities-only, £1,000 Saxo GIA, LSE 3× ETPs, long-only**. Docs 10–12 are superseded **on horizon** (#632). The binding constraint is **entry-signal accuracy**, not a published factor Sharpe **[verified: CLAUDE.md, ADR-0018 2026-09-14 amendment, doc 54]**.

| Bar | Figure | Tag |
|---|---|---|
| Saxo round trip | 16 bps commission (8 bps/side, no minimum) | **[verified]** ADR-0015 |
| Required accuracy edge | **+8.18 pp index / +4.66 pp single-stock** | **[verified]** ADR-0018 2026-09-14 / CLAUDE.md |
| Break-even directional accuracy | **52.6% (PLTR) → 58.5% (MSTR)** | **[verified]** doc 54 restatement |
| Drawdown tolerance | ~26% index / ~42% single-stock at 35%/25% | **[verified]** #798 / CONTEXT.md |
| Trial discipline | Hard eligibility gate, cut declared in advance; ranked axis forbidden | **[verified]** ADR-0018 D4, doc 56 filter 2 |
| Falsifier arm 2 | Same name, same bracket, technical-indicator entry, no LLM | **[verified]** CONTEXT.md, trader-spec control-arm module |

**Safest** = does not violate flat-by-close, does not blow the accepted envelope, does not add an undeclared trial. **Max profit** = moves the accuracy needle. Sizing infra cannot substitute for a missing selector win rate (#625: 96 debates / 0 trades when last recorded **[verified: CONTEXT.md]**).

**Core idea (transferable):** at this book, profit is **pp of same-session directional accuracy after 16 bps**, not “which famous strategy has the highest Sharpe in a textbook.”

---

## 2. Verdict table

| Topic | Verdict | Deciding filter |
|---|---|---|
| **Medallion clone** | **DOA** | Capacity, non-disclosure, shorting/HFT stack, not a spec. One transferable sentence already *is* Stage 0 (“many weak independent lenses”). |
| **Momentum as 12-1 / quintile / TSMOM hold** | **DOA as coded** | Filter 1 (multi-month), filter 2 (rank), filter 6 (short). Same kill as doc 56 Family 1 **[verified]**. |
| **Momentum as binary trailing-N sign-gate** | **Viable with modification — trial only, LOW effect-size** | Survives 1/2/6 if N and the zero threshold are declared first. Same-day slice is a **different hypothesis**. Mesfin 2026: 0/14 OHLCV *intraday* momentum families cleared a five-criterion net-of-friction bar on MNQ **[verified: arXiv:2605.04004v3 abstract]**. |
| **Swing** | **DOA** | Filter 1 / ADR-0014. Wikipedia definition is hold ≥1 day **[verified]**. Overnight gap is the excluded risk. |
| **Candlestick bull/bear cookbook** | **DOA as edge** | No cost-adjusted OOS claim fetched this pass that clears +4.66/+8.18 pp. Pattern match is subjective unless rules freeze **[verified: Wikipedia Candlestick pattern]**. **It is Arm 2’s null** **[inferred]**. |
| **Vector DB product (Qdrant/Chroma/Pinecone)** | **DOA as edge** | Semantic ANN/RAG **[verified: Wikipedia Vector database]**. Trader already has numeric cosine k-NN over SQLite `cosine_setups`, 0.5–1.5×, 0.75× no-precedent **[verified: trader-spec cosine module; F-1 closed]**. |
| **Cosine-store quality (not a new DB)** | **Admissible infra, off-target** | Can change sizing, not accuracy. k/θ/multiplier must stay declared (D4). |

---

## 3. Ranked recommendation

**Do first (not one of the five):** measure whether the live debate beats Arm 2. Until a win rate exists, every import is unfalsifiable against the thesis.

Then, of the five:

1. **Momentum sign-gate (or same-session reversal gate)** — only topic that *can* touch the binding constraint in an admissible shape. Prior is **pessimistic**. If a D4 slot is spent, pre-register **both signs** (continuation vs reversal) and score **directional accuracy**, never Sharpe. Required edge is the **charged** +4.66/+8.18 pp, not doc 56’s pre-restatement +3.35/+4.33.
2. **Cosine-store quality** — safest add, cannot create edge. Feature audit + R-multiple labelling + insert dedup. Do not fit k/θ on outcomes.
3. **Medallion** — metaphor. Do not build.
4. **Candles** — do not build; keep as the thing Arm 2 already is.
5. **Swing** — do not build.

**If forced to pick one topic to add:** (1) as a single pre-registered trial. **If forced to pick the safest add that cannot hurt the envelope:** (2). **The honest answer may be “add none of the five until #625 has a denominator.”**

---

## 4. What to build (foreground for the implementing agent)

Einstein does not implement. If an implementing agent is later pointed here:

**Foreground**

1. **Do not** open a new pipeline stage, broker, or overnight hold.
2. **Access:** Wikipedia + arXiv:2605.04004 are public. Medallion has **no licensed algorithm**. Cosine code is already in `server/pipeline/trader/` (`retrieveCosinePrecedent`, `setup-vector.ts`, `cosine_setups`). <!-- cite-exempt: historical — deleted in v1 teardown wave 3 (#1748); preserved at tag v1-final -->
3. **License boundary:** no Medallion IP; no scrape of LSE quotes (doc 58 F6 retracted). Mesfin paper is arXiv, not a strategy to copy — it is a **falsification** of OHLCV intraday momentum on MNQ, a cheaper venue than Saxo+ETP.
4. **Algorithm to reimplement (only if David spends a D4 slot):** binary gate `sign(r_{t-N,t})` with N frozen, threshold **exactly 0**, long-only, flatten by close. Second pre-registered arm: `sign(r_{t-N,t})` as a **fade** (reversal). Strip any quintile/weight/short. This is the modification doc 56 already named.
5. **Integration:** eligibility **before** debate, or as a skip_reason on the Trader — not a ranked axis inside debate. Must not silently expand `PIPELINE_STAGES`.
6. **Risks:** wrong sign (overnight premium / intraday reversal **[assumed from literature not re-fetched]**); Mesfin-style friction floor; D4 budget if N is searched; universe still possibly empty (doc 59).
7. **Source verification done this pass:** Wikipedia API + wikitext for Medallion numbers; arXiv Atom for 2605.04004v3; trader-spec cosine module; docs 54/56/59/CLAUDE.md/CONTEXT.md. Firecrawl search was 403; Marshall–Young–Rose PDF **not** re-read.

**Do not**

- Clone Medallion / add HFT / market-neutral
- Swing overlay / overnight
- Candle pattern table as entry
- Stand up a vector-DB product

---

## 5. Falsifiers (if the sign-gate trial is ever run)

Declare before looking:

1. Same-session drift conditional on trailing-N sign, net of 16 bps + the instrument’s measured spread, **indistinguishable from a coin flip** at the charged bar → trial dead.
2. Continuation arm and reversal arm **both** fail → do not go fishing for N.
3. Gate keeps so few sessions that MDE > bar (doc 51 precedent) → **UNMEASURABLE**, not a pass.

No gate is proposed here, so nothing composes with #750’s eligibility band until David spends the slot.

---

## 6. Knowledge gaps

1. Same-session accuracy of trailing-N sign on the **LSE 3× wrapper** — unmeasured **[verified: absence in docs 56/57]**.
2. Overnight vs intraday return split on these wrappers — not measured this pass.
3. Marshall–Young–Rose not re-extracted.
4. Spread + FX still floors (docs 59/54, #1220, #1053).
5. Selector win rate (#625) still unobserved.

---

## 7. Source index

| Source | Role |
|---|---|
| Parent Obsidian report | Synthesis |
| `samurai-five-topics-fit-2026-09-17-web-raw.md` | Wikipedia + arXiv extracts |
| `samurai-five-topics-fit-2026-09-17-opus-raw.md` | Fit analysis vs live ADRs |
| ADR-0014, ADR-0018 | Product |
| Docs 54, 56, 59 | Bars, prior grill, universe |
| arXiv:2605.04004v3 | Intraday OHLCV momentum falsification |
| `docs/specs/trader-spec.md` cosine module | Existing “vector” layer | <!-- cite-exempt: historical — v1 record; the file was deleted per ruling G8 and is preserved at tag v1-final -->

Trial count this doc adds: **0**. A future sign-gate measurement would be **2** if both signs are pre-registered (continuation, reversal), plus whatever N is frozen — N must not be a third look.
