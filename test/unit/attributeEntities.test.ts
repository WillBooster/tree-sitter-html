import path from 'node:path';
import { Edit, Language, Parser, Query } from '@willbooster/web-tree-sitter';
import { expect, test } from 'vitest';

await Parser.init();
const language = await Language.load(path.join(import.meta.dirname, '../../tree-sitter-html.wasm'));

test('exposes references inside complete quoted and unquoted attribute values', () => {
  const parser = new Parser().setLanguage(language);
  const query = new Query(language, '(attribute_value (entity) @reference)');
  try {
    for (const delimiter of ['"', "'", '']) {
      const value = 'before&amp;&#128512;&#X000041;&CounterClockwiseContourIntegral;after';
      const source = `<a title= ${delimiter}${value}${delimiter}>body&amp;tail</a><p>after</p>`;
      const tree = parser.parse(source)!;
      try {
        expect(tree.rootNode.hasError, source).toBe(false);
        const attribute = tree.rootNode.descendantsOfType('attribute_value');
        expect(attribute).toHaveLength(1);
        expect(attribute[0]!.text).toBe(value);
        const references = query.captures(tree.rootNode).map(({ node }) => node);
        expect(references.map((node) => node.text)).toEqual([
          '&amp;',
          '&#128512;',
          '&#X000041;',
          '&CounterClockwiseContourIntegral;',
        ]);
        for (const reference of references) {
          expect(source.slice(reference.startIndex, reference.endIndex)).toBe(reference.text);
          expect(reference.parent?.id).toBe(attribute[0]!.id);
        }
        expect(tree.rootNode.lastNamedChild?.text).toBe('<p>after</p>');
      } finally {
        tree.delete();
      }
    }
  } finally {
    query.delete();
    parser.delete();
  }
});

test('keeps ambiguous ampersands and incomplete references in the attribute value', () => {
  const parser = new Parser().setLanguage(language);
  try {
    for (const delimiter of ['"', "'"]) {
      const value = ' ?a=1&b=2 &copy=1 &copycat; &notit; &unknown; &# &#x &#X; ';
      const source = `<a href=${delimiter}${value}${delimiter}></a><p>after</p>`;
      const tree = parser.parse(source)!;
      try {
        expect(tree.rootNode.hasError, source).toBe(false);
        expect(tree.rootNode.descendantsOfType('attribute_value').map((node) => node.text)).toEqual([value]);
        expect(tree.rootNode.descendantsOfType('entity')).toHaveLength(0);
        expect(tree.rootNode.lastNamedChild?.text).toBe('<p>after</p>');
      } finally {
        tree.delete();
      }
    }
  } finally {
    parser.delete();
  }
});

test('keeps literal ampersands inside one unquoted value before the next attribute', () => {
  const parser = new Parser().setLanguage(language);
  try {
    const value = 'left&copycat;&notit;&unknown;&#&#x&' + 'a'.repeat(64) + 'right';
    const tree = parser.parse(`<a title=${value} other="keep&amp;me"></a><p>after</p>`)!;
    try {
      expect(tree.rootNode.hasError).toBe(false);
      expect(tree.rootNode.descendantsOfType('attribute_value').map((node) => node.text)).toEqual([
        value,
        'keep&amp;me',
      ]);
      expect(tree.rootNode.descendantsOfType('entity').map((node) => node.text)).toEqual(['&amp;']);
      expect(tree.rootNode.descendantsOfType('attribute_name').map((node) => node.text)).toEqual(['title', 'other']);
      expect(tree.rootNode.lastNamedChild?.text).toBe('<p>after</p>');
    } finally {
      tree.delete();
    }
  } finally {
    parser.delete();
  }
});

test('preserves whitespace around references and consumes numeric references without a semicolon', () => {
  const parser = new Parser().setLanguage(language);
  try {
    const value = ' \n&copy &#65x &#x41g &amp;=end\n ';
    const tree = parser.parse(`<a title="${value}"></a>`)!;
    try {
      expect(tree.rootNode.hasError).toBe(false);
      expect(tree.rootNode.descendantsOfType('attribute_value')[0]!.text).toBe(value);
      expect(tree.rootNode.descendantsOfType('entity').map((node) => node.text)).toEqual([
        '&copy',
        '&#65',
        '&#x41',
        '&amp;',
      ]);
    } finally {
      tree.delete();
    }
  } finally {
    parser.delete();
  }
});

test('keeps comment-shaped attribute content literal and comments outside tags independently queryable', () => {
  const parser = new Parser().setLanguage(language);
  try {
    const source = '<!--before--><a title="<!--literal-->&amp;">body<!--inside--></a><!--after-->';
    const tree = parser.parse(source)!;
    try {
      expect(tree.rootNode.hasError).toBe(false);
      expect(tree.rootNode.descendantsOfType('attribute_value').map((node) => node.text)).toEqual([
        '<!--literal-->&amp;',
      ]);
      expect(tree.rootNode.descendantsOfType('comment').map((node) => node.text)).toEqual([
        '<!--before-->',
        '<!--inside-->',
        '<!--after-->',
      ]);
      expect(tree.rootNode.descendantsOfType('entity').map((node) => node.text)).toEqual(['&amp;']);
    } finally {
      tree.delete();
    }
    const invalid = parser.parse('<a <!--invalid--> href="ok">body</a><p>after</p>')!;
    try {
      expect(invalid.rootNode.hasError).toBe(true);
      for (const tag of invalid.rootNode.descendantsOfType('start_tag')) {
        expect(tag.descendantsOfType('comment')).toHaveLength(0);
      }
      expect(invalid.rootNode.lastNamedChild?.text).toBe('<p>after</p>');
    } finally {
      invalid.delete();
    }
  } finally {
    parser.delete();
  }
});

test('keeps a contiguous slash in unquoted values and distinguishes separated self-closing delimiters', () => {
  const parser = new Parser().setLanguage(language);
  try {
    for (const value of ['foo&amp;/', 'foo&/', 'foo/', '&amp;/', '&/', '&#65/', '&unknown;/']) {
      const source = `<a title=${value}>body</a><p>after</p>`;
      const tree = parser.parse(source)!;
      try {
        expect(tree.rootNode.hasError, source).toBe(false);
        expect(tree.rootNode.descendantsOfType('attribute_value').map((node) => node.text)).toEqual([value]);
        expect(tree.rootNode.firstNamedChild?.text).toBe(`<a title=${value}>body</a>`);
        expect(tree.rootNode.descendantsOfType('self_closing_tag')).toHaveLength(0);
        expect(tree.rootNode.lastNamedChild?.text).toBe('<p>after</p>');
      } finally {
        tree.delete();
      }
    }
    for (const source of ['<a title=foo&amp; /><p>after</p>', '<a title="foo&amp;"/><p>after</p>']) {
      const tree = parser.parse(source)!;
      try {
        expect(tree.rootNode.hasError, source).toBe(false);
        expect(tree.rootNode.descendantsOfType('self_closing_tag')).toHaveLength(1);
        expect(tree.rootNode.descendantsOfType('attribute_value').map((node) => node.text)).toEqual(['foo&amp;']);
        expect(tree.rootNode.lastNamedChild?.text).toBe('<p>after</p>');
      } finally {
        tree.delete();
      }
    }
  } finally {
    parser.delete();
  }
});

test('incrementally updates an attribute reference without changing neighboring values', () => {
  const parser = new Parser().setLanguage(language);
  const source = '<a title="before &copy=1 after" other="keep&amp;me">body</a><p>after</p>';
  const previous = parser.parse(source)!;
  try {
    const startIndex = source.indexOf('&copy') + '&copy'.length;
    const updated = `${source.slice(0, startIndex)};${source.slice(startIndex)}`;
    previous.edit(
      new Edit({
        startIndex,
        oldEndIndex: startIndex,
        newEndIndex: startIndex + 1,
        startPosition: { row: 0, column: startIndex },
        oldEndPosition: { row: 0, column: startIndex },
        newEndPosition: { row: 0, column: startIndex + 1 },
      })
    );
    const incremental = parser.parse(updated, previous)!;
    const fresh = parser.parse(updated)!;
    try {
      expect(incremental.rootNode.hasError).toBe(false);
      expect(incremental.rootNode.toString()).toBe(fresh.rootNode.toString());
      expect(incremental.rootNode.descendantsOfType('entity').map((node) => node.text)).toEqual(['&copy;', '&amp;']);
      expect(incremental.rootNode.descendantsOfType('attribute_value').map((node) => node.text)).toEqual([
        'before &copy;=1 after',
        'keep&amp;me',
      ]);
      expect(incremental.rootNode.lastNamedChild?.text).toBe('<p>after</p>');
    } finally {
      incremental.delete();
      fresh.delete();
    }
  } finally {
    previous.delete();
    parser.delete();
  }
});
