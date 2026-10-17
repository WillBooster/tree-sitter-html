import { expect, test } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { Edit, Language, Parser, type Tree } from '@willbooster/web-tree-sitter';

const root = path.resolve(import.meta.dirname, '../..');
await Parser.init();
const language = await Language.load(path.join(root, 'tree-sitter-html.wasm'));

for (const depth of [100, 201, 202, 210]) {
  const prefix = `${'<xyz>'.repeat(depth)}<section><custom-a>`;
  const source = `${prefix}<br>text<script>content</script></custom-a></section><br>tail${'</xyz>'.repeat(depth)}`;
  const offset = prefix.length + '<br>'.length;
  const edited = `${source.slice(0, offset)}edited${source.slice(offset + 4)}`;

  test(`preserves active tags at depth ${depth} in native fresh and incremental parses`, () => {
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
          maxBuffer: 4 * 1024 * 1024,
        });
        expect(result.error).toBeUndefined();
        expect([0, 1]).toContain(result.status);
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
  }, 90_000);

  test(`preserves active tags at depth ${depth} in Wasm fresh and incremental parses`, () => {
    const parser = new Parser();
    parser.setLanguage(language);
    const tree = parser.parse(source)!;
    try {
      checkActiveTags(tree, 'text');
      editLine(tree, offset, 4, 'edited');
      const incremental = parser.parse(edited, tree)!;
      const fresh = parser.parse(edited)!;
      try {
        checkActiveTags(incremental, 'edited');
        expect(incremental.rootNode.toString()).toBe(fresh.rootNode.toString());
        editLine(incremental, 0, 0, '<xyz>');
        editLine(incremental, edited.length + 5, 0, '</xyz>');
        const wrapped = `<xyz>${edited}</xyz>`;
        const wrappedIncremental = parser.parse(wrapped, incremental)!;
        const wrappedFresh = parser.parse(wrapped)!;
        try {
          checkActiveTags(wrappedIncremental, 'edited');
          expect(wrappedIncremental.rootNode.toString()).toBe(wrappedFresh.rootNode.toString());
        } finally {
          wrappedIncremental.delete();
          wrappedFresh.delete();
        }
      } finally {
        incremental.delete();
        fresh.delete();
      }
    } finally {
      tree.delete();
      parser.delete();
    }
  }, 30_000);
}

function checkActiveTags(tree: Tree, text: string): void {
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
