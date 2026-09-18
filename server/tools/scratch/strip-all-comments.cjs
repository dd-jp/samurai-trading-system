// Deletes all comments from source files, except behavior-changing directive
// comments (lint suppressions, ts-directives, triple-slash references)
// Run from repo root: node <this-file> [--dry-run]
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { parseSync } = require('oxc-parser');

const DRY_RUN = process.argv.includes('--dry-run');

const EXTS = ['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs'];
const EXCLUDE = [':!:docs/research/archive/**', ':!:server/tools/__fixtures__/path-citations/**'];

const DIRECTIVE_RE =
  /^[!*\s]*@?(eslint-disable|eslint-enable|oxlint-disable|oxlint-enable|biome-ignore|prettier-ignore|ts-ignore|ts-expect-error|ts-nocheck|istanbul ignore|c8 ignore|v8 ignore|vitest-environment|<reference\b)/i;

function listFiles() {
  const patterns = EXTS.map((e) => `*.${e}`);
  const out = execFileSync('git', ['ls-files', '--', ...patterns, ...EXCLUDE], {
    encoding: 'utf8',
  });
  return out.split('\n').filter(Boolean);
}

function parseFile(filePath, src) {
  try {
    const result = parseSync(filePath, src);
    if (result.errors.length > 0) {
      console.error(`PARSE ERRORS, skipped: ${filePath}`);
      return null;
    }
    return result;
  } catch (err) {
    console.error(`PARSE FAILED: ${filePath}: ${err.message}`);
    return null;
  }
}

function partitionComments(comments) {
  const toRemove = [];
  let kept = 0;
  for (const c of comments) {
    if (DIRECTIVE_RE.test(c.value)) {
      kept += 1;
    } else {
      toRemove.push(c);
    }
  }
  return { toRemove, kept };
}

function removalRangeFor(out, comment) {
  const { start, end } = comment;
  const lineStart = out.lastIndexOf('\n', start - 1) + 1;
  const wholeLineComment = /^[ \t]*$/.test(out.slice(lineStart, start));

  let nextNewline = out.indexOf('\n', end);
  if (nextNewline === -1) nextNewline = out.length;
  const restOfLineBlank = /^[ \t]*$/.test(out.slice(end, nextNewline));

  if (wholeLineComment && restOfLineBlank) {
    return { start: lineStart, end: nextNewline < out.length ? nextNewline + 1 : nextNewline };
  }

  let trimmedStart = start;
  while (trimmedStart > lineStart && /[ \t]/.test(out[trimmedStart - 1])) trimmedStart -= 1;
  return { start: trimmedStart, end };
}

function removeComments(src, toRemove) {
  const sorted = [...toRemove].sort((a, b) => b.start - a.start);
  let out = src;
  for (const c of sorted) {
    const { start, end } = removalRangeFor(out, c);
    out = out.slice(0, start) + out.slice(end);
  }
  return out.replace(/\n{3,}/g, '\n\n');
}

function stripFile(filePath) {
  const src = fs.readFileSync(filePath, 'utf8');
  const parsed = parseFile(filePath, src);
  if (!parsed) return { changed: false, removed: 0, kept: 0 };

  const { toRemove, kept } = partitionComments(parsed.comments);
  if (toRemove.length === 0) return { changed: false, removed: 0, kept };

  const out = removeComments(src, toRemove);
  if (out === src) return { changed: false, removed: 0, kept };

  if (!DRY_RUN) fs.writeFileSync(filePath, out);
  return { changed: true, removed: toRemove.length, kept };
}

const files = listFiles();
let filesChanged = 0;
let totalRemoved = 0;
let totalKept = 0;

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
