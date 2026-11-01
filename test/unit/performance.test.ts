import fs from 'node:fs';
import path from 'node:path';

import { Language, Parser } from '@willbooster/web-tree-sitter';
import { expect, test } from 'vitest';

import { generationInputMtime } from '../helpers/generationInputs.js';

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
test('recovers from an error on each line in linear time', { timeout: 60_000 }, () => {
  expectLinearParseTime('<p a=\n'.repeat(2000), '<p a=\n'.repeat(20_000), true);
});

test('looks up unmatched end tags below repeated and alternating opens in linear time', { timeout: 60_000 }, () => {
  for (const open of ['<xyz>', '<section><x-a>']) {
    const source = (count: number): string => `${open.repeat(count)}x${'</abc>'.repeat(count)}`;
    expectLinearParseTime(source(2000), source(20_000), true);
  }
});

test('drains implicit descendants before a long ancestor close in linear time', { timeout: 60_000 }, () => {
  for (const count of [1000, 10_000]) {
    const tree = parser.parse(longAncestorClose(count))!;
    try {
      expect(tree.rootNode.namedChildren.map((node) => node.type)).toEqual(['element', 'element']);
      expect(tree.rootNode.firstNamedChild?.lastNamedChild?.text).toBe(`</x-${'a'.repeat(count)}>`);
      expect(tree.rootNode.lastNamedChild?.text).toBe('<p>after</p>');
      expect(tree.rootNode.descendantsOfType('start_tag')).toHaveLength(count + 2);
    } finally {
      tree.delete();
    }
  }
  expectLinearParseTime(longAncestorClose(1000), longAncestorClose(10_000), false);
});

test('parses deeply nested repeated and alternating tags in linear time', { timeout: 60_000 }, () => {
  for (const pair of [
    ['<xyz>', '</xyz>'],
    ['<section><x-a>', '</x-a></section>'],
  ]) {
    const nest = (depth: number): string => `${pair[0]!.repeat(depth)}x${pair[1]!.repeat(depth)}`;
    expectLinearParseTime(nest(1000), nest(10_000), false);
  }
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

function longAncestorClose(count: number): string {
  const name = `x-${'a'.repeat(count)}`;
  return `<${name}>${'<section>'.repeat(count)}x</${name}><p>after</p>`;
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
