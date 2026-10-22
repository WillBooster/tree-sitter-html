import { expect, test } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

import { generationInputMtime } from '../helpers/generationInputs.js';

import { Language, Parser } from '@willbooster/web-tree-sitter';

const Root = path.join(import.meta.dirname, '../..');
const WasmPath = path.join(Root, 'tree-sitter-html.wasm');
await Parser.init();
const parser = new Parser();
parser.setLanguage(await Language.load(WasmPath));

// The tests load the existing Wasm build, so a stale one would hide an edit that makes error recovery slower than linear.
test('uses a Wasm build built from the current parser', () => {
  const sources = [
    'grammar.js',
    ...fs
      .readdirSync(path.join(Root, 'src'), { recursive: true, encoding: 'utf8' })
      .filter((file) => /\.[ch]$/.test(file))
      .map((file) => `src/${file}`),
  ].map((name) => fs.statSync(path.join(Root, name)).mtimeMs);
  expect(
    Math.max(generationInputMtime(Root), ...sources) > fs.statSync(WasmPath).mtimeMs,
    'generation inputs or src/ changed after the Wasm build was built; run `bun run build/ci`'
  ).toBe(false);
});

// Consumers parse files being edited, so recovering from many errors must stay linear: ten times the lines take about
// ten times as long, against a hundred times for quadratic recovery. The ratio catches a cost that grows faster than
// the input even on a slow CI runner. The parses are timed in the CPU time of the thread that runs them: wall-clock
// time is inflated unevenly by the test files running alongside, and the process's CPU time also counts the engine's
// background threads, which compile the Wasm build and collect garbage during the parses. 2,000 and 20,000 lines are
// measured after warm-up parses and in alternation, each keeping its fastest run; their ratio is about 10 locally, and
// 18 leaves a margin over that while failing for growth faster than about n^1.25.
// Each line is a start tag broken off in an attribute. The scanner keeps a stack of the open elements and walks
// it for implicit end tags, so lines that each leave an element open (e.g. `<b></i>`) take time that grows faster than
// the input, with upstream's parser as well.
test('recovers from an error on each line in linear time', { timeout: 60_000 }, () => {
  expectLinearParseTime('<p a=\n'.repeat(2000), '<p a=\n'.repeat(20_000), true);
});

// The scanner stores, serializes, and restores its open-tag stack before most tokens, so its cost per token must not
// grow with the nesting depth of repeated tags.
test('parses deeply nested repeated tags in linear time', { timeout: 60_000 }, () => {
  expectLinearParseTime(nestRepeatedTags(1000), nestRepeatedTags(10_000), false);
});

test.each([' ', '/', ' a=x '])('reads malformed long tag names in linear input work at %j', (suffix) => {
  const reads = [250, 1000].map((count) => {
    const source = `<div>x${'<a'.repeat(count)}${suffix}</div><p>after</p>`;
    let characters = 0;
    const tree = parser.parse((index) => {
      const chunk = source.slice(index, index + 64);
      characters += chunk.length;
      return chunk;
    })!;
    try {
      expect(tree.rootNode.hasError).toBe(true);
      expect(tree.rootNode.firstNamedChild?.text).toBe(source.slice(0, source.indexOf('<p>')));
      expect(tree.rootNode.lastNamedChild?.text).toBe('<p>after</p>');
    } finally {
      tree.delete();
    }
    return characters;
  });
  expect(reads[1]! / reads[0]!).toBeLessThan(6);
});

function nestRepeatedTags(depth: number): string {
  return `${'<xyz>'.repeat(depth)}x${'</xyz>'.repeat(depth)}`;
}

function expectLinearParseTime(small: string, large: string, hasError: boolean): void {
  parseCpuTime(large, hasError);
  parseCpuTime(large, hasError);
  let smallFastest = Infinity;
  let largeFastest = Infinity;
  for (let run = 0; run < 5; run++) {
    smallFastest = Math.min(smallFastest, parseCpuTime(small, hasError));
    largeFastest = Math.min(largeFastest, parseCpuTime(large, hasError));
  }
  expect(largeFastest / smallFastest).toBeLessThan(18);
}

function parseCpuTime(source: string, expectedError: boolean): number {
  const start = process.threadCpuUsage();
  const tree = parser.parse(source);
  const { system, user } = process.threadCpuUsage(start);
  if (!tree) throw new Error('The parser returned no tree');
  const { hasError } = tree.rootNode;
  tree.delete();
  expect(hasError).toBe(expectedError);
  return system + user;
}
