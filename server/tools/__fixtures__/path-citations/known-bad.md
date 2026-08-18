# Known-bad citations

Every citation in this file must be flagged. Line numbers are asserted in
`check-path-citations.test.ts`, so adding or removing lines above an existing
case will fail that suite — add new cases at the end.

A dead path: `server/pipeline/verdict/no-such-file.ts`.

A drifted line beyond end of file: `server/tools/check-path-citations.ts:99999`.

A line number on a directory: `server/tools/:12`.

A stale `planned` marker whose path now resolves: `server/tools/check-path-citations.ts`. <!-- cite-exempt: planned — this file does not exist yet -->

A marker with an unknown reason: `server/pipeline/verdict/gone.ts`. <!-- cite-exempt: whatever — not a recognised reason -->

A marker with no written justification: `server/pipeline/verdict/also-gone.ts`. <!-- cite-exempt: historical -->
