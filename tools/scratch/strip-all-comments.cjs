// Deletes all comments from source files, except behavior-changing directive
// comments (lint suppressions, ts-directives, triple-slash references).
// Run from repo root: node <this-file> [--dry-run]
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { parseSync } = require('oxc-parser');

const DRY_RUN = process.argv.includes('--dry-run');

const EXTS = ['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs'];
const EXCLUDE = [':!:docs/research/archive/**'];

const DIRECTIVE_RE =
  /^[!*\s]*@?(eslint-disable|eslint-enable|oxlint-disable|oxlint-enable|biome-ignore|prettier-ignore|ts-ignore|ts-expect-error|ts-nocheck|istanbul ignore|c8 ignore|v8 ignore|vitest-environment|<reference\b)/i;

function listFiles() {
  const patterns = EXTS.map((e) => `*.${e}`);
  const out = execFileSync('git', ['ls-files', '--', ...patterns, ...EXCLUDE], { encoding: 'utf8' });
  return out.split('\n').filter(Boolean);
}

function stripFile(filePath) {
  const src = fs.readFileSync(filePath, 'utf8');
  let result;
  try {
    result = parseSync(filePath, src);
  } catch (err) {
    console.error(`PARSE FAILED: ${filePath}: ${err.message}`);
    return { changed: false, removed: 0, kept: 0 };
  }
  if (result.errors.length > 0) {
    console.error(`PARSE ERRORS, skipped: ${filePath}`);
    return { changed: false, removed: 0, kept: 0 };
  }

  const toRemove = [];
  let kept = 0;
  for (const c of result.comments) {
    if (DIRECTIVE_RE.test(c.value)) {
      kept += 1;
      continue;
    }
    toRemove.push(c);
  }
  if (toRemove.length === 0) return { changed: false, removed: 0, kept };

  toRemove.sort((a, b) => b.start - a.start);
  let out = src;
  for (const c of toRemove) {
    let start = c.start;
    let end = c.end;

    const lineStart = out.lastIndexOf('\n', start - 1) + 1;
    const beforeOnLine = out.slice(lineStart, start);
    const wholeLineComment = /^[ \t]*$/.test(beforeOnLine);

    let nextNewline = out.indexOf('\n', end);
    if (nextNewline === -1) nextNewline = out.length;
    const afterOnLine = out.slice(end, nextNewline);
    const restOfLineBlank = /^[ \t]*$/.test(afterOnLine);

    if (wholeLineComment && restOfLineBlank) {
      // Own-line comment: drop the whole line (including its newline) so no
      // blank line is left behind.
      start = lineStart;
      end = nextNewline < out.length ? nextNewline + 1 : nextNewline;
    } else {
      // Trailing comment: drop it and any trailing whitespace back to the
      // last non-space char, keep the code and the newline.
      while (start > lineStart && /[ \t]/.test(out[start - 1])) start -= 1;
    }
    out = out.slice(0, start) + out.slice(end);
  }

  out = out.replace(/\n{3,}/g, '\n\n');

  if (out !== src) {
    if (!DRY_RUN) fs.writeFileSync(filePath, out);
    return { changed: true, removed: toRemove.length, kept };
  }
  return { changed: false, removed: 0, kept };
}

const files = listFiles();
let filesChanged = 0;
let totalRemoved = 0;
let totalKept = 0;
const failed = [];

for (const f of files) {
  const abs = path.resolve(f);
  const r = stripFile(abs);
  if (r.changed) filesChanged += 1;
  totalRemoved += r.removed;
  totalKept += r.kept;
}

console.log(`files scanned: ${files.length}`);
console.log(`files changed: ${filesChanged}`);
console.log(`comments removed: ${totalRemoved}`);
console.log(`directive comments kept: ${totalKept}`);
if (failed.length) console.log(`failed: ${failed.length}`);
