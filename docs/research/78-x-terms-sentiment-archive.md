# X and xAI terms for the sentiment archive (#1685)

**Question** ([#1685](https://github.com/dd-jp/samurai-trading-system/issues/1685), follow-on of [#969](https://github.com/dd-jp/samurai-trading-system/issues/969) under the closed map [#522](https://github.com/dd-jp/samurai-trading-system/issues/522); social enters v2 as a counted trial under G18, [#1753](https://github.com/dd-jp/samurai-trading-system/issues/1753)): do X's Developer Agreement, Developer Policy and display rules, and xAI's terms, permit Samurai to store a narrowed projection of each X post indefinitely for backtest replay? The projection is status id, permalink, author handle, post timestamp and a derived sentiment score, with no post text.

**Short answer: unclear, and this doc cannot settle it.** Every primary source was unreachable from this session (below), so the clauses quoted here are as surfaced by web search on 2026-10-04, not read from the pages. On that evidence: nothing found bars using X posts to inform trading; X's terms, if they bind Samurai, require deletion on request and treat post IDs and derivative works as X Content, so indefinite retention with no deletion path is the part most likely to be out of bounds; and whether they bind a party that never accepted them and never touched the X API is a contract question David should take advice on. This is not legal advice.

## How the evidence was gathered, and its limit

Retrieval date for every source: 2026-10-04.

The session's egress proxy refused every host that holds a primary text: `developer.x.com`, `docs.x.com`, `legal.x.com`, `x.com`, `x.ai`, `docs.x.ai`, `portal.nousresearch.com`, `hermes-agent.nousresearch.com`, `openrouter.ai`, and the secondary mirrors tried (`platform-policy-wiki.com`, `fedscoop.com`). The proxy's rule is that a policy block is reported, not routed around, so no archive copy was fetched either.

What remains is the web-search tool, which returns a search model's rendering of the pages it indexed. Text in quotation marks below is that rendering. Where the search returned the same wording across several queries, or quoted a clause with its section heading, it is likely close to the page; it has not been checked character by character against the live page, and the pages' effective dates were not visible. Treat every quote here as a lead to verify, not as the clause.

Source pages the quotes are attributed to:

| Short name | URL |
|---|---|
| X Developer Agreement | https://docs.x.com/developer-terms/agreement |
| X Developer Policy | https://docs.x.com/developer-terms/policy (also developer.x.com/en/developer-terms/policy) |
| X restricted uses | https://docs.x.com/developer-terms/restricted-use-cases |
| X display requirements | https://developer.x.com/en/developer-terms/display-requirements |
| xAI enterprise terms | https://x.ai/legal/terms-of-service-enterprise |
| xAI acceptable use policy | https://x.ai/legal/acceptable-use-policy |
| xAI consumer terms | https://x.ai/legal/terms-of-service |
| OpenRouter terms | https://openrouter.ai/terms |
| Nous Portal terms | https://portal.nousresearch.com/terms |

## Premise check against the tree

Two facts in the ticket's framing are not quite what the code does.

**The fetch path has three intermediaries, not one.** `server/providers/news/grok/x-search-client.ts` calls `nousResponses` against the Nous base URL with the OpenRouter-routed alias `~x-ai/grok-latest`; #969 found `x_search` runs only on that alias. So posts reach Samurai as Grok output, from xAI, routed by OpenRouter, sold by Nous. Samurai's only direct contract is with Nous. Samurai never calls the X API and holds no X developer account.

**More than the narrowed projection is stored.** `server/providers/news/grok/grok-agent.ts` writes the narrowed projection (status id, permalink, handle, posted time, entity, sentiment, confidence, retrieval time) to `mi_archive_raw`, as #969 said. The same write also puts the whole item into `mi_items.item_json` (`server/providers/news/archive/mi-archive-store.ts`), and that item carries Grok's `headline` and optional `summary` of the post. Separately, the spend sink records the raw model response in `llm_call_log`, capped in length (`server/shared/debate/llm/spend-sink.ts`). Those are Grok's restatements, not the post body, but nothing stops Grok quoting the post, so "no verbatim body" holds for the raw row only. Any design change below has to cover all three tables. Retrieval defaults off, so none of this has run in production.

## Verdicts

| # | Question | Verdict | Basis |
|---|---|---|---|
| 0 | Store the projection indefinitely for backtest replay | **Unclear** | Turns on 1b and 1c. If X's terms bind, indefinite retention with no deletion path is likely not permitted; the fields themselves are not barred. |
| a | xAI's terms on storing or redistributing `x_search` results | **Unclear, leaning permitted for private storage** | Nothing found on `x_search` results specifically. The customer owns Output and carries third-party rights in it. |
| b | Do X's terms bind a party that never signed the Developer Agreement | **Unclear** | The Agreement binds on "accessing or using any Licensed Material", and X Content includes content made available "by any other means authorized by X". Whether that reaches Samurai is a legal question. |
| c | Retention and deletion compliance | **Not permitted as built, if X's terms bind** | 24-hour deletion on written request; post IDs are themselves X Content. The ID-only rule governs sharing with third parties, not retention. |
| d | Derived scores, and their use for automated trading | **Trading use: permitted as far as found. Stored scores keyed to a post: unclear** | No trading or financial-analysis ban found. "Derivative works" of X Content are X Content, so a score tied to a post may carry the post's deletion duty. |
| — | Display requirements | **Not engaged (inference)** | They govern displaying a post. Samurai displays no post. |
| — | No-training clause | **Not engaged** | Samurai does not train a foundation or frontier model. |

### (a) xAI's terms

As surfaced, the xAI enterprise terms (which xAI applies to its API) say:

- Output is "any response, result, generated content, or other material produced by the Services in response to an Input", and "As between Customer and xAI, Customer owns the output of the Services provided to Customer based on Input."
- "Customer is solely responsible for independently evaluating the accuracy, completeness, and suitability of any Output before relying on or distributing it."
- Customer indemnifies xAI against claims that "Customer's use or distribution of Outputs ... infringes or misappropriates a third party's intellectual-property rights."
- "If Customer directs or configures the Services to transmit Input or Output to any third-party platform or service, Customer represents that Customer has all necessary rights and consents to do so and remains fully responsible therefor."

The acceptable use policy, as surfaced, bars "modifying, copying, translating, leasing, selling, reselling, distributing, distilling ... the Service", and asks users not to "mislead people as to the nature and source of Outputs".

What the terms say: nothing found addresses `x_search` results, X posts or citation URLs as a class, and nothing found restricts storing Output. What I infer: xAI hands the customer the Output and, with it, whatever duties a third party (here X) attaches to the material in it. xAI's terms neither license X's content to Samurai nor discharge X's terms. The AUP's "distributing ... the Service" clause is about the service, not about Output, and Samurai redistributes nothing anyway. Not found: whether xAI's `x_search` documentation tells API users that X's terms apply to the posts it returns. That is the single most useful page to read when a route to it exists.

The chain adds two more contracts. OpenRouter's terms, as surfaced, require users to use Models "in accordance with ... the applicable Model Terms" and make them "solely responsible for any violation ... of applicable Model Terms", so xAI's terms probably reach Samurai through OpenRouter whether or not Nous passes them on. Nous Portal's terms could not be read; a search result reported that no service-specific data-handling terms were found on the Nous surfaces. Whether Nous's terms pass provider terms through, and whether Samurai is an "Authorized User" of OpenRouter at all, is unproven.

### (b) Does X's agreement bind a non-signatory

As surfaced, the X Developer Agreement:

- is "a binding legal agreement between you ... and X and governs your access to and use of the Licensed Material";
- binds on "accessing or using any Licensed Material, or clicking on a button to accept the terms of this Agreement or recurring subscription payment for Paid Services";
- defines "Licensed Material" as "the X API and X Content", and "X Content" as "Posts, the unique identification number generated for each Post, X end user profile information, and any other data and information made available to you through the X API or by any other means authorized by X, and any copies and derivative works thereof."

What the terms say: acceptance is by use, and X Content is defined to include data that arrives "by any other means authorized by X". What I infer, without overclaiming: X authorised xAI (its own affiliate) to serve posts through `x_search`, so X could argue that a post ID and handle received through Grok is X Content "made available ... by any other means authorized by X", and that storing it is "using" Licensed Material. Against that, Samurai never visited the agreement, clicked anything, paid X, or used the X API, and terms of use generally bind only someone who had notice of them and assented. Whether a clickless, notice-less "by use" clause binds a downstream recipient under English or US law is exactly the question to take advice on.

Two further routes by which X's terms could still reach Samurai, neither tested: (1) if David holds an X account, the X user Terms of Service bind him personally, and they have their own rules on automated access and content; a search result says a revised X Terms of Service takes effect on 2026-10-09, five days after this doc, and it was not read; (2) xAI or OpenRouter could pass X's conditions down contractually. Neither was found in what was surfaced.

### (c) Retention and deletion

As surfaced, the Developer Agreement's Removals clause says: "If X Content is deleted, gains protected status, or is otherwise suspended, withheld, modified, or removed from the X Applications (including removal of location information), you will make all reasonable efforts to delete or modify that X Content (as applicable) as soon as possible, and in any case within twenty four (24) hours after a written request to do so by X or by an X user with regard to its X Content unless prohibited by law or regulation and with the express written permission of X."

The Developer Policy, as surfaced: "If you provide X Content to third parties, including downloadable datasets or via an API, you may only distribute Post IDs, Direct Message IDs, and/or User IDs", and "You may not distribute more than 1,500,000 Post IDs to any entity ... within any 30 day period unless you have received written permission from X."

What the terms say: the duty is triggered by a written request from X or the user, and runs to "that X Content"; Post IDs are named in the X Content definition. The ID-only rule sits under redistribution to third parties. What I infer:

- **The hydration exception does not cover retention.** It is a rule about what may be handed to someone else, so that the recipient re-fetches ("hydrates") through the API and the deletion state comes with the fetch. It does not exempt a stored ID from the Removals clause. Samurai redistributes nothing (single user, localhost dashboard), so the 1.5M cap and the ID-only rule are not engaged; the Removals clause is.
- **Samurai cannot meet the Removals clause as built.** X's compliance signals (compliance streams and batch compliance jobs) are X API products. Without an X API account, Samurai has no feed of deletions and no way to receive a written request addressed to it. "Reasonable efforts" might be met by a periodic re-check, but the only re-check route Samurai has is another Grok call, which is not a lookup by ID and would not reliably show that a post is gone.
- **Replay and deletion pull against each other.** CLAUDE.md requires any past day to replay to the same decisions. If a deleted post's score is removed, a replay of that day no longer reproduces the decision. The design has to say which wins, and how a replay records a gap caused by a deletion.

If X's terms do not bind Samurai, none of this is a contractual duty. Data-protection law is a separate track: the handle plus post time is personal data under UK GDPR whichever terms apply, and a private single-user system may or may not fall inside the household exemption. Not researched here; flagged for the same adviser.

### (d) Derived scores, and trading use

As surfaced, X's restricted-use page covers sensitive characteristics ("You should never derive, infer, or store information about a user's health ..., negative financial status or condition, political affiliation or beliefs, ..."), off-X matching, surveillance ("credit or insurance risk analyses, individual profiling or psychographic segmentation", "investigating or tracking X users or their content"), advertising outside X, and, since June 2025, a bar on using "the X API or X Content to fine-tune or train a foundation or frontier model". A later policy change, reported but not dated in what was surfaced, revoked API access for "InfoFi" apps that pay users for posting. The Agreement's licence, as surfaced, is to "integrate X Content into your Services or conduct analysis of the X Content, as explicitly approved by X."

One search result rendered the Policy as permitting "Aggregate analysis of X content that does not store any personal data (for example, user IDs, usernames, and other identifiers)". An exact-phrase search for that sentence found nothing, so it is unverified.

What the terms say: no clause found bars using X content to inform trading or financial analysis. "Negative financial status or condition" is about the posting user's own finances, not about a security's price. What I infer:

- **Trading use is not the problem.** A per-instrument sentiment score for NVDA is not a sensitive characteristic of any user, not surveillance and not off-X matching. Storing the handle is the closest brush with the profiling clauses, and Samurai's use of it (provenance) is not profiling.
- **The derived score may still carry the post's duties.** "Copies and derivative works thereof" are X Content, so a score stored against a status ID could be argued to be X Content and subject to Removals. A score pooled across posts with no ID or handle beside it is much harder to call a derivative work of any one post.
- **The handle is what moves the archive out of the aggregate case.** If the unverified aggregate sentence is real, a store with no usernames or IDs is inside it, and the current store, which keeps both, is not.
- **"As explicitly approved by X"** is the licence's own condition for analysis. It presupposes an X developer account and an approved use case, which Samurai does not have. That is a reason the licence does not fit Samurai, not evidence that the analysis is barred.

### Display requirements

As surfaced, they require the author's profile picture, @username and display name, a timestamp linking to the permalink, the X logo and the action icons whenever a post is displayed. Samurai's dashboard shows no post. If a future dashboard view lists a handle and a permalink, that is a link to X, not a rendered post; whether X would see it differently was not checked.

## Consequence for the archive design

Not decided here: the archive design is David's call. The options, with what each depends on:

| Option | What changes | Keeps replay | Risk it leaves |
|---|---|---|---|
| **1. Keep as is** | Nothing. | Yes, per post. | Rests on X's terms not binding Samurai (1b). Stores handles, Grok's headline and summary, and the raw response with no deletion path. Weakest position if X's terms do bind. |
| **2. Strip to ID plus score** | Drop handle, permalink (it contains the handle; `x.com/i/status/<id>` rebuilds a link), `headline`, `summary` and the raw response text for X items, in all three tables. | Yes, per post. | IDs and per-post scores are still X Content under the Removals clause if X's terms bind; still no deletion signal. Removes the personal-data and quotation exposure. |
| **3. Option 1 or 2 plus a deletion sweep** | A job that re-checks stored IDs and removes deleted ones. | Partly: a swept post leaves a hole in that day's replay, which must be recorded as a gap. | Needs a deletion signal Samurai does not have; the clean one is X's own compliance API, which means an X developer account and its cost, and accepting the Developer Agreement outright. Cost not measured. |
| **4. Aggregate only** | Store one score per instrument per refresh bucket (count, mean, dispersion); no IDs, handles or text. Citations stay in the live debate's evidence and are not persisted. | Yes, at the bucket level, if the sentiment input is redefined to read the bucket rather than per-post items. | Loses per-post audit, and bot-share measurement (#1686) would need its own per-post data. Strongest fit with the unverified aggregate-analysis sentence. |
| **5. Citation-only fallback** (#969's named fallback) | No archive row; the post is cited in the live evidence and dropped. | **No.** Conflicts with the replay invariant unless the score is kept somewhere, and a kept score is option 2 or 4 under another name. | Social inputs become non-replayable, which undermines the G18 counted trial's own measurement against its shadow. |
| **6. Drop X** | Retire the X social trial. | n/a | Loses the only reachable social source (StockTwits closed, Reddit gated). |

Observation, not a recommendation: options 2 and 4 cost little and remove the exposures that do not depend on the binding question; option 3 is the only one that meets the Removals clause, and only by accepting X's agreement. Whatever is chosen, the three-table finding above applies to it.

## What is unproven

- Every quote above: none was read from the live page; effective dates unknown.
- Whether the aggregate-analysis sentence exists in the current X Developer Policy.
- Whether xAI's `x_search` documentation or API terms say X's terms govern returned posts.
- Nous Portal's terms, and whether they pass provider terms through; whether OpenRouter's Model Terms clause reaches Samurai through Nous.
- The X Terms of Service revision said to take effect on 2026-10-09, and whether David holds an X account.
- Whether a deletion sweep is feasible without the X API, and what X API compliance access would cost.
- UK GDPR position of storing handles in a private trading system.

## What David should get advice on

1. Whether X's Developer Agreement, which binds "by accessing or using any Licensed Material", can bind a party that received post IDs and handles only as xAI API output, through OpenRouter and Nous, with no notice or acceptance (1b).
2. Whether a sentiment score keyed to a post ID is a "derivative work" that carries the 24-hour Removals duty (1d).
3. Whether storing X handles in a private single-user trading system is processing of personal data outside the household exemption.

A cheaper first step than advice, on the binding question only: ask xAI in writing whether API customers may store `x_search` post IDs and derived scores indefinitely, and whether X's developer terms apply to them. A written yes from xAI, X's affiliate, would carry more weight than any reading of the terms here.
