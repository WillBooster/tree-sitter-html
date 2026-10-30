import path from 'node:path';

import { Language, Parser, Query } from '@willbooster/web-tree-sitter';
import { expect, test } from 'vitest';

await Parser.init();
const language = await Language.load(path.join(import.meta.dirname, '../../tree-sitter-html.wasm'));

test('keeps void elements from owning following content or stray end tags', () => {
  const parser = new Parser().setLanguage(language);
  const query = new Query(language, '(void_element (tag_name) @void)');
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
      expect(tree.rootNode.descendantsOfType('entity').map((node) => node.text)).toEqual(['&amp;']);
    } finally {
      tree.delete();
    }
  } finally {
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
      ['<svg><font data-note="color=red face size">', '</font></svg>'],
      ['<math><font colorful=red>', '</font></math>'],
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
      const tree = parser.parse(`${open}<input>text<br>tail${close}`)!;
      try {
        expect(tree.rootNode.hasError).toBe(false);
        expect(tree.rootNode.descendantsOfType('void_element').map((node) => node.text)).toEqual(['<input>', '<br>']);
        expect(tree.rootNode.descendantsOfType('text').map((node) => node.text)).toEqual(['text', 'tail']);
        expect(tree.rootNode.descendantsOfType('erroneous_end_tag')).toHaveLength(0);
      } finally {
        tree.delete();
      }
    }
  } finally {
    parser.delete();
  }
});

test('classifies void elements by tag name while retaining sibling ranges', () => {
  const parser = new Parser().setLanguage(language);
  try {
    for (const name of ['x-input', 'input']) {
      const source = `<section><${name}>text<p>after</p></section>`;
      const tree = parser.parse(source)!;
      try {
        const following = tree.rootNode.descendantsOfType('element').find((node) => node.text === '<p>after</p>');
        expect([following?.startIndex, following?.endIndex]).toEqual([
          source.indexOf('<p>'),
          source.indexOf('</section>'),
        ]);
        if (name === 'input') {
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
        tree.delete();
      }
    }
  } finally {
    parser.delete();
  }
});

test('leaves foreign content at a void breakout while retaining source ranges and later HTML mode', () => {
  const parser = new Parser().setLanguage(language);
  const query = new Query(language, '(void_element (tag_name) @void)');
  try {
    const source = '<section><svg><text>before<br>between<input>after</text></svg><p>outside</p></section>';
    const tree = parser.parse(source)!;
    try {
      expect(tree.rootNode.hasError).toBe(false);
      expect(query.captures(tree.rootNode).map(({ node }) => node.text)).toEqual(['br', 'input']);
      const section = tree.rootNode.firstNamedChild!;
      const nodes = section.namedChildren;
      expect(nodes.find((node) => node.text === '<svg><text>before')?.type).toBe('element');
      const lineBreak = nodes.find((node) => node.type === 'void_element' && node.text === '<br>')!;
      expect([lineBreak.startIndex, lineBreak.endIndex]).toEqual([
        source.indexOf('<br>'),
        source.indexOf('<br>') + '<br>'.length,
      ]);
      expect(lineBreak.nextNamedSibling?.text).toBe('between');
      const input = nodes.find((node) => node.type === 'void_element' && node.text === '<input>')!;
      expect(input.nextNamedSibling?.text).toBe('after');
      expect(nodes.filter((node) => node.type === 'erroneous_end_tag').map((node) => node.text)).toEqual([
        '</text>',
        '</svg>',
      ]);
      expect(nodes.find((node) => node.text === '<p>outside</p>')?.type).toBe('element');
    } finally {
      tree.delete();
    }
  } finally {
    query.delete();
    parser.delete();
  }
});

test('computes foreign breakout boundaries from the opening name', () => {
  const parser = new Parser().setLanguage(language);
  try {
    for (const name of ['embed', 'input']) {
      const source = `<section><math><${name}>foreign</input></math><p>after</p></section>`;
      const tree = parser.parse(source)!;
      try {
        expect(tree.rootNode.descendantsOfType('void_element').map((node) => node.text)).toEqual(
          name === 'embed' ? ['<embed>'] : []
        );
        const section = tree.rootNode.firstNamedChild!;
        expect(section.namedChildren.some((node) => node.type === 'text' && node.text === 'foreign')).toBe(
          name === 'embed'
        );
        const following = tree.rootNode.descendantsOfType('element').find((node) => node.text === '<p>after</p>');
        expect([following?.startIndex, following?.endIndex]).toEqual([
          source.indexOf('<p>'),
          source.indexOf('</section>'),
        ]);
      } finally {
        tree.delete();
      }
    }
  } finally {
    parser.delete();
  }
});

test('applies nonvoid and conditional font breakouts before following HTML void starts', () => {
  const parser = new Parser().setLanguage(language);
  try {
    for (const [open, name] of [
      ['<p>', 'p'],
      ['<font color=red>', 'font'],
      ['<font FACE="a > b">', 'font'],
      ['<font size>', 'font'],
    ]) {
      const source = `<section><svg>${open}<input><span>x</span></${name}></svg><p>after</p></section>`;
      const tree = parser.parse(source)!;
      try {
        expect(tree.rootNode.hasError, source).toBe(false);
        const input = tree.rootNode.descendantsOfType('void_element').find((node) => node.text === '<input>')!;
        expect(input?.nextNamedSibling?.text, source).toBe('<span>x</span>');
        expect(input?.parent?.text, source).toBe(`${open}<input><span>x</span></${name}>`);
        expect([input?.startIndex, input?.endIndex], source).toEqual([
          source.indexOf('<input>'),
          source.indexOf('<input>') + '<input>'.length,
        ]);
        const section = tree.rootNode.firstNamedChild!;
        expect(section.namedChildren.some((node) => node.type === 'element' && node.text === '<svg>')).toBe(true);
        expect(section.namedChildren.some((node) => node.text === '<p>after</p>')).toBe(true);
      } finally {
        tree.delete();
      }
    }
  } finally {
    parser.delete();
  }
});
