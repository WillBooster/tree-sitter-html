import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { Language, Parser, type Tree } from '@willbooster/web-tree-sitter';
import { expect, test } from 'vitest';

const root = path.resolve(import.meta.dirname, '../..');
await Parser.init();
const language = await Language.load(path.join(root, 'tree-sitter-html.wasm'));

// Each wrapper nests the payload deeper than the scanner serialization buffer holds as one byte per tag.
// Repeated tags fit as runs, so the whole document must parse without errors; distinct tags overflow, so only
// the payload's active tags are guaranteed.
const wrappers = [
  { name: 'repeated custom tags', open: '<xyz>'.repeat(1100), close: '</xyz>'.repeat(1100), compressible: true },
  {
    name: 'runs of known and custom tags',
    open: `<main>${'<div>'.repeat(300)}${'<xyz>'.repeat(300)}${'<span>'.repeat(300)}<p><p-x>`,
    close: `</p-x></p>${'</span>'.repeat(300)}${'</xyz>'.repeat(300)}${'</div>'.repeat(300)}</main>`,
    compressible: true,
  },
  { name: 'alternating known tags', open: '<b><i>'.repeat(600), close: '</i></b>'.repeat(600), compressible: false },
];

for (const { name, open, close, compressible } of wrappers) {
  const prefix = `${open}<section><custom-a>`;
  const source = `${prefix}<br>text<script>content</script></custom-a></section><br>tail${close}`;
  const edited = source.replace('<br>text', '<br>edited');
  const wrapped = `<xyz>${edited}</xyz>`;

  test(`preserves active tags within ${name} in native parses`, () => {
    const directory = fs.mkdtempSync(path.join(root, '.tmp/serialized-stack-'));
    try {
      const file = path.join(directory, 'input.html');
      for (const [input, text] of [
        [source, 'text'],
        [edited, 'edited'],
        [wrapped, 'edited'],
      ] as const) {
        fs.writeFileSync(file, input);
        const result = spawnSync('script/tree-sitter', ['parse', file, '--xml'], {
          cwd: root,
          timeout: 30_000,
          env: { ...process.env, TREE_SITTER_LIBDIR: path.join(root, '.tmp/tree-sitter-lib') },
          encoding: 'utf8',
          maxBuffer: 16 * 1024 * 1024,
        });
        expect(result.error).toBeUndefined();
        expect(result.status).toBe(compressible ? 0 : 1);
        const compact = result.stdout.replaceAll(/<(\w+)\b[^>]*>/g, '<$1>').replaceAll(/\s+/g, '');
        expect(compact).toContain(`<void_element>&lt;<tag_name>br</tag_name>&gt;</void_element><text>${text}</text>`);
        expect(compact).toContain('<raw_text>content</raw_text>');
        expect(compact).toContain(
          '<tag_name>custom-a</tag_name>&gt;</end_tag></element><end_tag>&lt;/<tag_name>section</tag_name>'
        );
        expect(compact).toContain('</void_element><text>tail</text>');
      }
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  }, 120_000);

  test(`preserves active tags within ${name} in Wasm parses`, () => {
    const parser = new Parser();
    parser.setLanguage(language);
    try {
      for (const [input, text] of [
        [source, 'text'],
        [edited, 'edited'],
        [wrapped, 'edited'],
      ] as const) {
        const tree = parser.parse(input)!;
        try {
          checkActiveTags(tree, text, compressible);
        } finally {
          tree.delete();
        }
      }
    } finally {
      parser.delete();
    }
  }, 30_000);
}

for (const { name, complete, depth = 1 } of [
  { name: `x-${'a'.repeat(253)}`, complete: true },
  { name: `x-${'a'.repeat(254)}`, complete: true },
  { name: `x-${'a'.repeat(898)}`, complete: true },
  { name: `x-${'a'.repeat(1013)}`, complete: true },
  { name: `x-${'é'.repeat(128)}`, complete: true },
  { name: `x-${'a'.repeat(898)}`, complete: true, depth: 3 },
  { name: `x-${'a'.repeat(1014)}`, complete: false },
  { name: `x-${'a'.repeat(1098)}`, complete: false },
]) {
  test(`retains following markup with ${depth} ${Buffer.byteLength(name)}-byte custom names`, () => {
    const parser = new Parser().setLanguage(language);
    try {
      const prefix = `<${name}>`.repeat(depth);
      const suffix = `</${name}>`.repeat(depth);
      for (const content of ['before', 'edited']) {
        const source = `${prefix}${content}${suffix}<p>after</p>`;
        const tree = parser.parse(source)!;
        try {
          const following = tree.rootNode.descendantsOfType('element').find((node) => node.text === '<p>after</p>');
          expect(following?.startIndex).toBe(source.indexOf('<p>'));
          expect(following?.endIndex).toBe(source.length);
          if (complete) {
            expect(tree.rootNode.hasError).toBe(false);
            expect(tree.rootNode.firstNamedChild?.lastNamedChild?.text).toBe(`</${name}>`);
            expect(tree.rootNode.namedChildren.map((node) => node.text)).toEqual([
              `${prefix}${content}${suffix}`,
              '<p>after</p>',
            ]);
          }
        } finally {
          tree.delete();
        }
      }
    } finally {
      parser.delete();
    }
  });
}

function checkActiveTags(tree: Tree, text: string, compressible: boolean): void {
  expect(tree.rootNode.hasError).toBe(!compressible);
  const names = tree.rootNode.descendantsOfType('tag_name');
  const breaks = names.filter((node) => node.text === 'br').map((node) => node.parent);
  expect(breaks.map((node) => node?.text)).toEqual(['<br>', '<br>']);
  expect(breaks.map((node) => [node?.nextNamedSibling?.type, node?.nextNamedSibling?.text])).toEqual([
    ['text', text],
    ['text', 'tail'],
  ]);
  const custom = names.find((node) => node.text === 'custom-a')?.parent?.parent;
  expect(custom?.lastNamedChild?.text).toBe('</custom-a>');
  expect(custom?.parent?.lastNamedChild?.text).toBe('</section>');
  expect(tree.rootNode.descendantsOfType('raw_text').map((node) => node.text)).toEqual(['content']);
}
