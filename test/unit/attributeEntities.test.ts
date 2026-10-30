import path from 'node:path';

import { Language, Parser, Query } from '@willbooster/web-tree-sitter';
import { expect, test } from 'vitest';

await Parser.init();
const language = await Language.load(path.join(import.meta.dirname, '../../tree-sitter-html.wasm'));
const valueContentTypes = ['attribute_value', 'unquoted_attribute_value'];

test('exposes references inside complete quoted and unquoted attribute values', () => {
  const parser = new Parser().setLanguage(language);
  const query = new Query(
    language,
    '[(attribute_value (entity) @reference) (unquoted_attribute_value (entity) @reference)]'
  );
  try {
    for (const delimiter of ['"', "'", '']) {
      const value = '😀before&amp;&#128512;&#X000041;&CounterClockwiseContourIntegral;&amp;after';
      const source = `<a title= ${delimiter}${value}${delimiter}>body&amp;tail</a><p>after</p>`;
      const tree = parser.parse(source)!;
      try {
        expect(tree.rootNode.hasError, source).toBe(false);
        const attribute = tree.rootNode.descendantsOfType(valueContentTypes);
        expect(attribute).toHaveLength(1);
        expect(attribute[0]!.text).toBe(value);
        const references = query.captures(tree.rootNode).map(({ node }) => node);
        const spellings = ['&amp;', '&#128512;', '&#X000041;', '&CounterClockwiseContourIntegral;', '&amp;'];
        expect(references.map((node) => node.text)).toEqual(spellings);
        let offset = source.indexOf(value) + '😀before'.length;
        const ranges = spellings.map((spelling) => {
          const start = offset;
          offset += spelling.length;
          return [start, offset];
        });
        expect(references.map((node) => [node.startIndex, node.endIndex])).toEqual(ranges);
        for (const reference of references) {
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
        expect(tree.rootNode.descendantsOfType(valueContentTypes).map((node) => node.text)).toEqual([value]);
        expect(tree.rootNode.descendantsOfType('entity')).toHaveLength(0);
        expect(tree.rootNode.descendantsOfType(valueContentTypes)[0]!.children).toHaveLength(0);
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
      expect(tree.rootNode.descendantsOfType(valueContentTypes).map((node) => node.text)).toEqual([
        value,
        'keep&amp;me',
      ]);
      expect(tree.rootNode.descendantsOfType('entity').map((node) => node.text)).toEqual(['&amp;']);
      expect(tree.rootNode.descendantsOfType(valueContentTypes)[0]!.children).toHaveLength(0);
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
      expect(tree.rootNode.descendantsOfType(valueContentTypes)[0]!.text).toBe(value);
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

test('keeps comment-shaped attribute content literal and comments outside tags as separate nodes', () => {
  const parser = new Parser().setLanguage(language);
  try {
    const source = '<!--before--><a title="<!--literal-->&amp;">body<!--inside--></a><!--after-->';
    const tree = parser.parse(source)!;
    try {
      expect(tree.rootNode.hasError).toBe(false);
      expect(tree.rootNode.descendantsOfType(valueContentTypes).map((node) => node.text)).toEqual([
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
        expect(tree.rootNode.descendantsOfType(valueContentTypes).map((node) => node.text)).toEqual([value]);
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
        expect(tree.rootNode.descendantsOfType(valueContentTypes).map((node) => node.text)).toEqual(['foo&amp;']);
        expect(tree.rootNode.lastNamedChild?.text).toBe('<p>after</p>');
      } finally {
        tree.delete();
      }
    }
  } finally {
    parser.delete();
  }
});

test('keeps following elements when an end-tag terminator is missing before a reference', () => {
  const parser = new Parser().setLanguage(language);
  try {
    for (const gap of [' ', '\n', '\r\n']) {
      for (const content of ['&nbsp;', '&amp;', '&copy']) {
        const source = `<div>x</div${gap}${content}<p>after</p>`;
        const tree = parser.parse(source)!;
        try {
          expect(tree.rootNode.hasError, source).toBe(true);
          expect(tree.rootNode.lastNamedChild?.type, source).toBe('element');
          expect(tree.rootNode.lastNamedChild?.text, source).toBe('<p>after</p>');
          expect(tree.rootNode.descendantsOfType('end_tag').at(-1)?.text).toBe('</p>');
        } finally {
          tree.delete();
        }
      }
    }
  } finally {
    parser.delete();
  }
});

test('preserves raw-text elements after an unterminated unquoted start tag', () => {
  const parser = new Parser().setLanguage(language);
  try {
    for (const tag of ['script', 'style']) {
      for (const value of ['x', 'x&amp;y', 'x&unknown;', 'x&', 'x/']) {
        for (const gap of ['', ' ', '\n']) {
          const body = value === 'x' ? 'a' : 'content "<b>" & value';
          const source = `<img src=${value}${gap}<${tag}>${body}</${tag}><p>after</p>`;
          const tree = parser.parse(source)!;
          try {
            expect(tree.rootNode.hasError, source).toBe(true);
            const rawElement = tree.rootNode.descendantsOfType(`${tag}_element`);
            expect(rawElement, source).toHaveLength(1);
            expect(rawElement[0]!.descendantsOfType('raw_text').map((node) => node.text)).toEqual([body]);
            expect(tree.rootNode.descendantsOfType('tag_name').map((node) => node.text)).not.toContain('b');
            expect(tree.rootNode.lastNamedChild?.text, source).toBe('<p>after</p>');
          } finally {
            tree.delete();
          }
        }
      }
    }
  } finally {
    parser.delete();
  }
});

test('recognizes a completed attribute reference without changing neighboring values', () => {
  const parser = new Parser().setLanguage(language);
  const tree = parser.parse('<a title="before &copy;=1 after" other="keep&amp;me">body</a><p>after</p>')!;
  try {
    expect(tree.rootNode.hasError).toBe(false);
    expect(tree.rootNode.descendantsOfType('entity').map((node) => node.text)).toEqual(['&copy;', '&amp;']);
    expect(tree.rootNode.descendantsOfType(valueContentTypes).map((node) => node.text)).toEqual([
      'before &copy;=1 after',
      'keep&amp;me',
    ]);
    expect(tree.rootNode.lastNamedChild?.text).toBe('<p>after</p>');
  } finally {
    tree.delete();
    parser.delete();
  }
});

test('exposes only references as children of values containing literal ampersands', () => {
  const parser = new Parser().setLanguage(language);
  try {
    for (const quote of ['"', "'", '']) {
      const value = quote ? 'a && b &amp; c &unknown;' : 'a&&b&amp;c&unknown;';
      const source = `<a title=${quote}${value}${quote}></a><p>after</p>`;
      const tree = parser.parse(source)!;
      try {
        expect(tree.rootNode.hasError, source).toBe(false);
        const attribute = tree.rootNode.descendantsOfType(valueContentTypes)[0]!;
        expect(attribute.text, source).toBe(value);
        expect(
          attribute.children.map((node) => ({ type: node.type, named: node.isNamed, text: node.text })),
          source
        ).toEqual([{ type: 'entity', named: true, text: '&amp;' }]);
        expect(tree.rootNode.lastNamedChild?.text, source).toBe('<p>after</p>');
      } finally {
        tree.delete();
      }
    }
  } finally {
    parser.delete();
  }
});

test('preserves non-ASCII whitespace before references in unquoted values', () => {
  const parser = new Parser().setLanguage(language);
  try {
    for (const space of ['\u3000', '\u00A0', '\u2003', '\u200B', '\u0085', '\u2028', '\u2029']) {
      for (const reference of ['&amp;', '&unknown;', '&&x']) {
        const value = space + reference;
        const source = `<a title= \t${value}></a><p>after</p>`;
        const tree = parser.parse(source)!;
        try {
          expect(tree.rootNode.hasError, source).toBe(false);
          const attribute = tree.rootNode.descendantsOfType(valueContentTypes)[0]!;
          expect(attribute.text, source).toBe(value);
          expect(source.slice(attribute.startIndex, attribute.endIndex), source).toBe(value);
          expect(
            attribute.children.map((node) => node.text),
            source
          ).toEqual(reference === '&amp;' ? ['&amp;'] : []);
          expect(tree.rootNode.lastNamedChild?.text, source).toBe('<p>after</p>');
        } finally {
          tree.delete();
        }
      }
    }
  } finally {
    parser.delete();
  }
});

test('selects each outer attribute value once and its quote-free content', () => {
  const parser = new Parser().setLanguage(language);
  const outer = new Query(
    language,
    `[
    (unquoted_attribute_value)
    (singlequoted_attribute_value)
    (doublequoted_attribute_value)
  ] @value`
  );
  const content = new Query(language, '[(attribute_value) (unquoted_attribute_value)] @content');
  try {
    const source = `<a bare=one&amp;two double="three&#65;four" single='five&amp;six' empty="" noval= bool></a>`;
    const tree = parser.parse(source)!;
    try {
      expect(tree.rootNode.hasError).toBe(false);
      expect(outer.captures(tree.rootNode).map(({ node }) => [node.type, node.text])).toEqual([
        ['unquoted_attribute_value', 'one&amp;two'],
        ['doublequoted_attribute_value', '"three&#65;four"'],
        ['singlequoted_attribute_value', "'five&amp;six'"],
        ['doublequoted_attribute_value', '""'],
        ['unquoted_attribute_value', 'bool'],
      ]);
      expect(content.captures(tree.rootNode).map(({ node }) => node.text)).toEqual([
        'one&amp;two',
        'three&#65;four',
        'five&amp;six',
        'bool',
      ]);
      const attributes = tree.rootNode.descendantsOfType('attribute');
      expect(attributes).toHaveLength(5);
      expect(attributes.at(-1)?.text).toBe('noval= bool');
      expect(attributes.flatMap((node) => node.namedChildren.slice(1)).map((node) => node.type)).toEqual(
        outer.captures(tree.rootNode).map(({ node }) => node.type)
      );
    } finally {
      tree.delete();
    }
  } finally {
    content.delete();
    outer.delete();
    parser.delete();
  }
});

test('retains value and content ranges for each quote style in HTML and foreign content', () => {
  const parser = new Parser().setLanguage(language);
  const outer = new Query(
    language,
    `[
    (unquoted_attribute_value)
    (singlequoted_attribute_value)
    (doublequoted_attribute_value)
  ] @value`
  );
  const contentQuery = new Query(language, '[(attribute_value) (unquoted_attribute_value)] @content');
  try {
    for (const [prefix, suffix] of [
      ['<a title=', '>body</a><p>after</p>'],
      ['<svg><g title=', '>foreign</g></svg><p>after</p>'],
      ['<math><mtext><a title=', '>html</a></mtext></math><p>after</p>'],
    ] as const) {
      for (const { value, unquoted } of [
        { value: '😀a&amp;&#65;z', unquoted: true },
        { value: 'line\n&amp;tail', unquoted: false },
        { value: 'nul\0&amp;tail', unquoted: true },
        { value: '', unquoted: false },
      ]) {
        for (const serialized of [`"${value}"`, `'${value}'`, ...(unquoted ? [value] : [])]) {
          const source = prefix + serialized + suffix;
          const tree = parser.parse(source)!;
          try {
            expect(tree.rootNode.hasError, source).toBe(false);
            const outerValues = outer.captures(tree.rootNode).map(({ node }) => node);
            expect(outerValues.map((node) => [node.text, node.startIndex, node.endIndex])).toEqual([
              [serialized, prefix.length, prefix.length + serialized.length],
            ]);
            const quoteLength = serialized === value ? 0 : 1;
            const expectedContent = value
              ? [[value, prefix.length + quoteLength, prefix.length + quoteLength + value.length]]
              : [];
            expect(
              contentQuery.captures(tree.rootNode).map(({ node }) => [node.text, node.startIndex, node.endIndex])
            ).toEqual(expectedContent);
            expect(tree.rootNode.lastNamedChild?.text).toBe('<p>after</p>');
          } finally {
            tree.delete();
          }
        }
      }
    }
  } finally {
    contentQuery.delete();
    outer.delete();
    parser.delete();
  }
});
