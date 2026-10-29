import fs from 'node:fs';
import path from 'node:path';

import { Language, Parser, Query } from '@willbooster/web-tree-sitter';
import { expect, test } from 'vitest';

await Parser.init();
const language = await Language.load(path.join(import.meta.dirname, '../../tree-sitter-html.wasm'));

test.each(
  ['<div>done</div>', '<svg><g /></svg>', '<ul><li>a<li>b</ul>'].flatMap((prefix) =>
    ['p', 'p class="a"', 'p id=x\n'].map((tail) => [prefix, tail] as const)
  )
)('EOF start tags retain captures: %s<%s', (prefix, tail) => {
  const parser = new Parser().setLanguage(language);
  const query = new Query(language, fs.readFileSync(new URL('../../queries/highlights.scm', import.meta.url), 'utf8'));
  const source = `${prefix}<${tail}`;
  const tree = parser.parse(source)!;
  try {
    expect(tree.rootNode.hasError).toBe(true);
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
  } finally {
    tree.delete();
    query.delete();
    parser.delete();
  }
});
