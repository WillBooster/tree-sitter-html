import { expect, test } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

import { Edit, Language, Parser, Query } from '@willbooster/web-tree-sitter';

const root = path.join(import.meta.dirname, '../..');
await Parser.init();
const language = await Language.load(path.join(root, 'tree-sitter-html.wasm'));
const querySource = fs.readFileSync(path.join(root, 'queries/injections.scm'), 'utf8');

for (const tag of ['script', 'style']) {
  test(`preserves ${tag} injection content through lookalike closing names`, () => {
    const parser = new Parser();
    parser.setLanguage(language);
    const query = new Query(language, querySource);
    try {
      for (const content of [
        `x</${tag}X><p>still raw</p>`,
        `x</${tag}-x><p>still raw</p>`,
        `x</${tag}\v><p>still raw</p>`,
        `x</${tag}\u00A0><p>still raw</p>`,
        `x</ſ${tag.slice(1)}><p>still raw</p>`,
        'x\0y',
        '<',
        `</${tag.slice(0, 3)}`,
        ...(tag === 'script'
          ? [
              '<!-- <script></script><em>inside</em>',
              '<!-- <ScRiPt></sCrIpT>',
              '<!-- <script/ignored></script >',
              '<!-- <script\t>\0</script\n>',
              '<!-- <script> -->',
              '<!-- <script> --->',
              '<!-- <script> <!-- -->',
              '<!-- <scriptX>',
              '<!-- <script\v>',
              '<!-- <script> </scriptX></script>',
              '<!-- <script> </script\v></script>',
              '<!-- <script></script><script></script>',
              '<!-->',
              '<!-- x',
            ]
          : ['<!-- <script>']),
      ]) {
        const tree = parser.parse(`<${tag}>${content}</${tag.toUpperCase()}><p>after</p>`)!;
        try {
          expect(tree.rootNode.hasError, content).toBe(false);
          expect(
            tree.rootNode.namedChildren.map((node) => node.type),
            content
          ).toEqual([`${tag}_element`, 'element']);
          expect(
            query.captures(tree.rootNode).map(({ name, node }) => [name, node.text]),
            content
          ).toEqual([['injection.content', content]]);
          expect(tree.rootNode.lastNamedChild?.text, content).toBe('<p>after</p>');
        } finally {
          tree.delete();
        }
      }
    } finally {
      query.delete();
      parser.delete();
    }
  });
}

test('preserves script injection through EOF and adding a real closing tag', () => {
  const parser = new Parser();
  parser.setLanguage(language);
  const query = new Query(language, querySource);
  try {
    for (const content of [
      'console.log(1);',
      '<!-- <script>',
      'var a = "<!-- <script>";</script>\n<p>content</p>\n<script>var b = 1;</script>\n<p>tail</p>',
    ]) {
      const source = `<script>${content}`;
      const tree = parser.parse(source)!;
      try {
        expect(tree.rootNode.hasError, content).toBe(false);
        expect(tree.rootNode.namedChildren.map((node) => node.type)).toEqual(['script_element']);
        expect(query.captures(tree.rootNode).map(({ name, node }) => [name, node.text])).toEqual([
          ['injection.content', content],
        ]);
        const suffix = '--></script><p>after</p>';
        const lines = source.split('\n');
        const position = { row: lines.length - 1, column: lines.at(-1)!.length };
        tree.edit(
          new Edit({
            startIndex: source.length,
            oldEndIndex: source.length,
            newEndIndex: source.length + suffix.length,
            startPosition: position,
            oldEndPosition: position,
            newEndPosition: { row: position.row, column: position.column + suffix.length },
          })
        );
        const updated = parser.parse(source + suffix, tree)!;
        const fresh = parser.parse(source + suffix)!;
        try {
          expect(updated.rootNode.toString()).toBe(fresh.rootNode.toString());
          expect(updated.rootNode.hasError).toBe(false);
          expect(updated.rootNode.lastNamedChild?.text).toBe('<p>after</p>');
          expect(query.captures(updated.rootNode).map(({ node }) => node.text)).toEqual([content + '-->']);
        } finally {
          updated.delete();
          fresh.delete();
        }
      } finally {
        tree.delete();
      }
    }
  } finally {
    query.delete();
    parser.delete();
  }
});
