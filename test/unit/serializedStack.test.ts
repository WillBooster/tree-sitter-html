import { expect, test } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { Edit, Language, Parser, type Tree } from '@willbooster/web-tree-sitter';

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
  const offset = prefix.length + '<br>'.length;
  const edited = `${source.slice(0, offset)}edited${source.slice(offset + 4)}`;
  const wrapped = `<xyz>${edited}</xyz>`;

  test(`preserves active tags within ${name} in native fresh and incremental parses`, () => {
    const directory = fs.mkdtempSync(path.join(root, '.tmp/serialized-stack-'));
    try {
      const file = path.join(directory, 'input.html');
      fs.writeFileSync(file, source);
      for (const [text, edits] of [
        ['text', []],
        ['edited', ['--edits', `${offset} 4 edited`]],
        ['edited', ['--edits', `${offset} 4 edited`, '0 0 <xyz>', `${edited.length + 5} 0 </xyz>`]],
      ] as const) {
        const result = spawnSync('script/tree-sitter', ['parse', file, '--xml', ...edits], {
          cwd: root,
          timeout: 30_000,
          env: { ...process.env, TREE_SITTER_LIBDIR: path.join(root, '.tmp/tree-sitter-lib') },
          encoding: 'utf8',
          maxBuffer: 16 * 1024 * 1024,
        });
        expect(result.error).toBeUndefined();
        expect(result.status).toBe(compressible ? 0 : 1);
        const compact = result.stdout.replaceAll(/<(\w+)\b[^>]*>/g, '<$1>').replaceAll(/\s+/g, '');
        expect(compact).toContain(
          `<element><start_tag>&lt;<tag_name>br</tag_name>&gt;</start_tag></element><text>${text}</text>`
        );
        expect(compact).toContain('<raw_text>content</raw_text>');
        expect(compact).toContain(
          '<tag_name>custom-a</tag_name>&gt;</end_tag></element><end_tag>&lt;/<tag_name>section</tag_name>'
        );
        expect(compact).toContain('</start_tag></element><text>tail</text>');
      }
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  }, 120_000);

  test(`preserves active tags within ${name} in Wasm fresh and incremental parses`, () => {
    const parser = new Parser();
    parser.setLanguage(language);
    const trees: Tree[] = [];
    const parse = (text: string, old?: Tree): Tree => {
      const tree = parser.parse(text, old)!;
      trees.push(tree);
      return tree;
    };
    try {
      const tree = parse(source);
      checkActiveTags(tree, 'text', compressible);
      editLine(tree, offset, 4, 'edited');
      const incremental = parse(edited, tree);
      checkActiveTags(incremental, 'edited', compressible);
      expect(incremental.rootNode.toString()).toBe(parse(edited).rootNode.toString());
      editLine(incremental, 0, 0, '<xyz>');
      editLine(incremental, edited.length + 5, 0, '</xyz>');
      const wrappedIncremental = parse(wrapped, incremental);
      checkActiveTags(wrappedIncremental, 'edited', compressible);
      expect(wrappedIncremental.rootNode.toString()).toBe(parse(wrapped).rootNode.toString());
    } finally {
      for (const tree of trees) tree.delete();
      parser.delete();
    }
  }, 30_000);
}

function checkActiveTags(tree: Tree, text: string, compressible: boolean): void {
  expect(tree.rootNode.hasError).toBe(!compressible);
  const names = tree.rootNode.descendantsOfType('tag_name');
  const breaks = names.filter((node) => node.text === 'br').map((node) => node.parent?.parent);
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

function editLine(tree: Tree, start: number, deleted: number, inserted: string): void {
  tree.edit(
    new Edit({
      startIndex: start,
      oldEndIndex: start + deleted,
      newEndIndex: start + inserted.length,
      startPosition: { row: 0, column: start },
      oldEndPosition: { row: 0, column: start + deleted },
      newEndPosition: { row: 0, column: start + inserted.length },
    })
  );
}
