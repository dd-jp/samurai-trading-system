# Pass criterion for #685, declared before the corrected arm was run

Committed ahead of the run so the ordering is verifiable in `git log`. This file
records what was expected; the run record it is judged against is
`2026-08-18-earnings-lookahead-rerun.txt` in this directory.

## What is being corrected

`docs/research/18-threshold-study.py`, `earnings_dates()`:

```python
out.add((d, "next" if mins >= 16 * 60 else "same"))
```

1. Any release before 16:00 ET is labelled "same session". For a release at
   11:00 ET the study's entry — the 09:30 open — **precedes the event** the
   session is being labelled for. Look-ahead.
2. A pre-market headline and a post-close headline on the same date add both a
   `"same"` and a `"next"` marker, so one event can mark two reaction days.

## The corrected rule (declared)

- **< 09:30 ET** → the same session reacts from the open. Clean; keep.
- **09:30–15:59 ET** → the release lands *inside* the session. **Exclude the
  session from both the event arm and the ordinary arm.** Excluding is chosen
  over modelling entry at the release because modelling would change the entry
  rule for a subset of sessions only, so the event arm would no longer be
  comparable either to the ordinary arm or to ADR-0018's open-entry baseline.
  One entry rule everywhere is the point of the comparison.
- **≥ 16:00 ET** → the next session reacts. Clean; keep.
- **Dedupe per (symbol, event)** before building the reaction set: matched
  headlines within a 5-day gap are one event (earnings are ~90 days apart, so
  the threshold cannot merge two real events), and the **earliest** headline in
  a cluster is the release. One event contributes at most one reaction day.

**The exclusion is applied to the event arm, the ordinary arm and the
combination — the same rule on both sides of the comparison.** It is *not*
applied to the pooled grid row, which does not partition on events at all: it is
the unconditional baseline over every session, and its n = 897 / −0.4257% is
cited by docs 50, 51 and 52 as reproducing to the digit.

## Pass criterion

1. **Reproduction gate.** The *unmodified* script, run on the re-fetched data,
   must reproduce the pooled grid row: **−0.4257%/trade, n = 897, t = −3.10**.
   If it does not, the data pull differs from the 2026-08-10 run, every
   corrected number is suspect, and the run stops for diagnosis rather than
   being published.
2. **Event count falls from 46.** Dedupe removes double-counted days and the
   intraday exclusion removes more, so the corrected count must be ≤ 46. A
   smaller k makes ADR-0018 Decision 2's structural argument (k/2657 = 1.73%)
   *stronger*, so D2 holds a fortiori and is not restated.
3. **n floor for inference, declared now: a t-statistic is reported only if the
   arm has n ≥ 10 out-of-sample.** Below that the finding is reported as "sample
   too small to support inference" and no t is printed as evidence. Note the
   script's existing in-sample gate is `len(ev_is) >= 8`; if the in-sample event
   count falls below 8 the event arm cannot be fitted at all, and that is
   reported as the outcome.
4. **Either sign is an acceptable outcome.** If the corrected event-day
   expectancy changes sign, or loses significance, that is the finding and is
   published as such. Nothing here is expected to defend −1.3267% / t = −4.19.
5. **Preserve, do not overwrite.** The superseded −1.3267% / t = −4.19 and
   −0.92% / t = −2.66 stay visible in doc 18 Result 4 and ADR-0018 Decision 2,
   marked as replaced by this run.

## Caveat that stands either way

The event-only figure is a 6-cell grid selected in-sample on ≤28 days and scored
on ≤18. That was true of the published number and is not fixed here. Whatever
sign the corrected number carries, it must be read with that selection attached.
