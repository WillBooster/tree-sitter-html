import fs from 'node:fs';
import path from 'node:path';

import { Edit, Language, Parser, Query } from '@willbooster/web-tree-sitter';
import { expect, test } from 'vitest';

await Parser.init();
const language = await Language.load(path.join(import.meta.dirname, '../../tree-sitter-html.wasm'));

test('exposes void elements to queries without owning following content or stray end tags', () => {
  const parser = new Parser().setLanguage(language);
  const query = new Query(language, '(void_element (tag_name) @void)');
  const highlights = new Query(
    language,
    fs.readFileSync(path.join(import.meta.dirname, '../../queries/highlights.scm'), 'utf8')
  );
  try {
    const source =
      '<section><INPUT disabled><br/><img src="a&amp;b">text</input><!-- sibling --><p>after</p></section>';
    const tree = parser.parse(source)!;
    try {
      expect(tree.rootNode.hasError).toBe(false);
      const section = tree.rootNode.firstNamedChild!;
      expect(section.namedChildren.map((node) => [node.type, node.text])).toEqual([
        ['start_tag', '<section>'],
        ['void_element', '<INPUT disabled>'],
        ['void_element', '<br/>'],
        ['void_element', '<img src="a&amp;b">'],
        ['text', 'text'],
        ['erroneous_end_tag', '</input>'],
        ['comment', '<!-- sibling -->'],
        ['element', '<p>after</p>'],
        ['end_tag', '</section>'],
      ]);
      expect(query.captures(tree.rootNode).map(({ node }) => node.text)).toEqual(['INPUT', 'br', 'img']);
      expect(
        highlights
          .captures(tree.rootNode)
          .filter(({ name }) => name === 'tag')
          .map(({ node }) => node.text)
      ).toEqual(['section', 'INPUT', 'br', 'img', 'p', 'p', 'section']);
      expect(tree.rootNode.descendantsOfType('entity').map((node) => node.text)).toEqual(['&amp;']);
    } finally {
      tree.delete();
    }
  } finally {
    highlights.delete();
    query.delete();
    parser.delete();
  }
});

test('uses ordinary elements in foreign content and void elements after HTML integration points', () => {
  const parser = new Parser().setLanguage(language);
  try {
    for (const [open, close] of [
      ['<svg><g>', '</g></svg>'],
      ['<math><annotation-xml>', '</annotation-xml></math>'],
    ]) {
      const source = `${open}<input>foreign</input>${close}<br><p>after</p>`;
      const tree = parser.parse(source)!;
      try {
        expect(tree.rootNode.hasError, source).toBe(false);
        expect(tree.rootNode.descendantsOfType('void_element').map((node) => node.text)).toEqual(['<br>']);
        expect(tree.rootNode.descendantsOfType('element').some((node) => node.text === '<input>foreign</input>')).toBe(
          true
        );
        expect(tree.rootNode.lastNamedChild?.text).toBe('<p>after</p>');
      } finally {
        tree.delete();
      }
    }
    for (const [open, close] of [
      ['<svg><foreignObject>', '</foreignObject></svg>'],
      ['<math><mtext>', '</mtext></math>'],
      ['<math><annotation-xml encoding="text/html">', '</annotation-xml></math>'],
    ]) {
      const tree = parser.parse(`${open}<input>text${close}`)!;
      try {
        expect(tree.rootNode.hasError).toBe(false);
        expect(tree.rootNode.descendantsOfType('void_element').map((node) => node.text)).toEqual(['<input>']);
        expect(tree.rootNode.descendantsOfType('text').map((node) => node.text)).toEqual(['text']);
      } finally {
        tree.delete();
      }
    }
  } finally {
    parser.delete();
  }
});

test('updates void classification and sibling ranges after editing and undoing tag names', () => {
  const parser = new Parser().setLanguage(language);
  let source = '<section><x-input>text<p>after</p></section>';
  let tree = parser.parse(source)!;
  try {
    for (const [previous, next] of [
      ['x-input', 'input'],
      ['input', 'x-input'],
    ] as const) {
      const offset = source.indexOf(previous);
      tree.edit(
        new Edit({
          startIndex: offset,
          oldEndIndex: offset + previous.length,
          newEndIndex: offset + next.length,
          startPosition: { row: 0, column: offset },
          oldEndPosition: { row: 0, column: offset + previous.length },
          newEndPosition: { row: 0, column: offset + next.length },
        })
      );
      source = source.slice(0, offset) + next + source.slice(offset + previous.length);
      const updated = parser.parse(source, tree)!;
      tree.delete();
      tree = updated;
      const fresh = parser.parse(source)!;
      try {
        expect(tree.rootNode.toString()).toBe(fresh.rootNode.toString());
        const following = tree.rootNode.descendantsOfType('element').find((node) => node.text === '<p>after</p>');
        expect([following?.startIndex, following?.endIndex]).toEqual([
          source.indexOf('<p>'),
          source.indexOf('</section>'),
        ]);
        if (next === 'input') {
          expect(tree.rootNode.descendantsOfType('void_element').map((node) => node.text)).toEqual(['<input>']);
          expect(tree.rootNode.firstNamedChild?.namedChildren.map((node) => node.type)).toEqual([
            'start_tag',
            'void_element',
            'text',
            'element',
            'end_tag',
          ]);
        } else {
          expect(tree.rootNode.descendantsOfType('void_element')).toHaveLength(0);
        }
      } finally {
        fresh.delete();
      }
    }
  } finally {
    tree.delete();
    parser.delete();
  }
});
