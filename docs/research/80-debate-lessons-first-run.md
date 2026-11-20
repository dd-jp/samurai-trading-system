# 80 — Debate lessons, first run (as_of 2026-11-20)

Refs [#2147](https://github.com/dd-jp/samurai-trading-system/issues/2147), G11 (doc 66, #1717).

## What this is

The first run of the G11 lesson writer over the paper store (`npm run v2:lessons -- 2026-11-20 <store> --distil`). It ran at 25 closed debate trades, the first trigger point. Code built the bucket statistics (`v2_lesson_buckets`, #2201). One call to the cheapest pinned model then wrote one sentence per qualifying bucket (`v2_lessons`, #2202). The call is journalled in `llm_call_log` under trace `v2-lessons-2026-11-20-debate/primary` and cost $0.0012. Lessons are research output only. None reaches a prompt until #2148 rules on that.

Inputs: `v2_decision_outcomes` rows settled before 2026-11-20. That is 25 debate decisions (`debate/primary`) and 28 for arm 2 (`arm2/technical-only`), the no-LLM control. Excess return is net of the trade's direction against the venue's index. Intervals are 95% bootstrap intervals with 2,000 resamples, seeded by the bucket's members.

## Buckets (n ≥ 10)

| Bucket | n | Mean excess | 95% interval | Hit rate | Arm 2 mean (n) |
|---|---|---|---|---|---|
| all | 25 | −11.03% | [−16.60%, −5.56%] | 24.0% | −6.25% (28) |
| direction=long | 12 | +0.54% | [−2.80%, +3.99%] | 41.7% | −2.15% (22) |
| direction=short | 13 | −21.72% | [−27.54%, −15.55%] | 7.7% | −21.32% (6) |
| venue=alpaca | 11 | +0.91% | [−2.58%, +4.72%] | 45.5% | −2.15% (20) |
| venue=saxo_cfd_usd | 13 | −21.72% | [−27.54%, −15.55%] | 7.7% | −21.32% (6) |
| news=0 | 12 | −14.23% | [−21.46%, −7.12%] | 16.7% | −6.25% (28) |
| confidence=0.7 | 25 | same as `all` | | | |
| disagreement=bull and bear disagree on direction | 25 | same as `all` | | | |

Arm 2's mean is on the same tag for `all`, `venue=` and `direction=`, and on all of arm 2's trades for a debate-only tag.

## Lessons (model-written, numbers from the table above)

- **all:** across all trades, mean excess return is negative, with the interval wholly below zero and a 24% hit rate.
- **direction=short:** shorts show a negative mean excess whose interval excludes zero. Arm 2's shorts did as badly: −21.3%, on 6 trades.
- **venue=saxo_cfd_usd:** the same 13 trades as the shorts, because every US short goes through Saxo CFDs. The model's claim notes that arm 2's mean is similar.
- **news=0:** with no headlines, mean excess is negative, with the interval wholly below zero and below arm 2's overall mean.
- **confidence=0.7** and **disagreement=…:** these restate `all`. The model wrote claims for them, but they carry no separate information (below).

The claims above are paraphrased. The stored text is in `v2_lessons`.

## Reading

- **The whole loss is the short book.** Longs (Alpaca) are flat to slightly positive, with intervals across zero. The 13 shorts lost about 22% each against the index, and arm 2's 6 shorts lost the same. So the losses come from shorting into this market, not from anything the debate adds. With n = 13 and 6, this is a pattern to watch, not yet a ruling.
- **Two tags are constant by design.** The judge maps agreeing debaters to a confidence, and the bull is always long and the bear always short. So every directional decision gets 0.75 and the same disagreement label. These buckets will only carry information if that mapping changes.
- **The kill line is not reached:** 25 closed trades, against 100. Recorded on #2147: the kill line's uncorrected per-bucket intervals make it fire rarely, and a losing bucket counts as "excluding zero". That correction is for David.
- **Asset-class and regime tags are absent,** because neither is journalled on the decision yet.

## Next run

Due when the debate book reaches 50 closed trades. A rerun at 2026-11-20 replays the logged answer and writes nothing.
