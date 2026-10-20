import fs from 'node:fs';
import path from 'node:path';
import { Edit, Language, Parser, Query } from '@willbooster/web-tree-sitter';
import { expect, test } from 'vitest';

await Parser.init();
const language = await Language.load(path.join(import.meta.dirname, '../../tree-sitter-html.wasm'));

test.each(
  ['<div>done</div>', '<svg><g /></svg>', '<ul><li>a<li>b</ul>'].flatMap((prefix) =>
    ['p', 'p class="a"', 'p id=x\n'].map((tail) => [prefix, tail] as const)
  )
)('EOF start tags retain captures after a real truncation: %s<%s', (prefix, tail) => {
  const parser = new Parser().setLanguage(language);
  const query = new Query(language, fs.readFileSync(new URL('../../queries/highlights.scm', import.meta.url), 'utf8'));
  const source = `${prefix}<${tail}`;
  const before = parser.parse(`${source}>`)!;
  const fresh = parser.parse(source)!;
  const point = { row: source.split('\n').length - 1, column: source.length - source.lastIndexOf('\n') - 1 };
  before.edit(
    new Edit({
      startIndex: source.length,
      oldEndIndex: source.length + 1,
      newEndIndex: source.length,
      startPosition: point,
      oldEndPosition: { row: point.row, column: point.column + 1 },
      newEndPosition: point,
    })
  );
  const incremental = parser.parse(source, before)!;
  try {
    expect(fresh.rootNode.hasError).toBe(true);
    expect(incremental.rootNode.toString()).toBe(fresh.rootNode.toString());
    for (const tree of [fresh, incremental]) {
      expect(tree.rootNode.firstNamedChild?.text).toBe(prefix);
      const tag = tree.rootNode.descendantsOfType('tag_name').at(-1)!;
      expect(tag.text).toBe('p');
      expect(tag.startIndex).toBe(prefix.length + 1);
      expect(tag.endIndex).toBe(prefix.length + 2);
      expect(
        query.captures(tree.rootNode).some(({ name, node }) => name === 'tag' && node.startIndex === tag.startIndex)
      ).toBe(true);
      if (tail.includes('=')) {
        const attribute = tree.rootNode.descendantsOfType('attribute_name').at(-1)!;
        expect(attribute.text).toBe(tail.includes('class=') ? 'class' : 'id');
        expect(attribute.startIndex).toBe(source.indexOf(attribute.text, prefix.length));
        expect(
          query
            .captures(tree.rootNode)
            .some(({ name, node }) => name === 'attribute' && node.startIndex === attribute.startIndex)
        ).toBe(true);
      }
    }
  } finally {
    incremental.delete();
    fresh.delete();
    before.delete();
    query.delete();
    parser.delete();
  }
});
