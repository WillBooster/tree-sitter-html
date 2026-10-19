import { expect, test } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import { Edit, Language, Parser, Query } from '@willbooster/web-tree-sitter';

await Parser.init();
const language = await Language.load(path.join(import.meta.dirname, '../../tree-sitter-html.wasm'));
const highlights = fs.readFileSync(path.join(import.meta.dirname, '../../queries/highlights.scm'), 'utf8');

for (const instruction of [
  '<?target data?>',
  '<?Target?>',
  '<?_target-2 data>',
  '<?target>',
  '<?target?data?>',
  '<?target ???>',
  '<?target \t\n\f\r data?>',
  '<?xml-stylesheet-extra href="x"?>',
  '<?target <span &amp; "quoted"?>',
]) {
  test(`preserves processing instruction and neighboring elements: ${JSON.stringify(instruction)}`, () => {
    const parser = new Parser().setLanguage(language);
    const query = new Query(language, highlights);
    const tree = parser.parse(`<div><br>${instruction}<p>after</p></div>`)!;
    try {
      expect(tree.rootNode.hasError).toBe(false);
      const node = tree.rootNode.descendantsOfType('processing_instruction')[0];
      expect(node?.text).toBe(instruction);
      expect(
        query
          .captures(tree.rootNode)
          .filter(({ name }) => name === 'keyword.directive')
          .map(({ node: capture }) => capture.text)
      ).toEqual([instruction]);
      expect(node?.parent?.type).toBe('element');
      expect(node?.parent?.firstNamedChild?.text).toBe('<div>');
      expect(node?.previousNamedSibling?.text).toBe('<br>');
      expect(node?.nextNamedSibling?.text).toBe('<p>after</p>');
    } finally {
      tree.delete();
      query.delete();
      parser.delete();
    }
  });
}

test('keeps invalid or reserved targets as comments without consuming following markup', () => {
  const parser = new Parser().setLanguage(language);
  try {
    for (const instruction of ['<?>', '<?1target?>', '<?é?>', '<?target:part?>', '<?XML?>', '<?XmL-StYlEsHeEt x?>']) {
      const tree = parser.parse(`${instruction}<p>after</p>`)!;
      try {
        expect(tree.rootNode.hasError, instruction).toBe(false);
        expect(tree.rootNode.firstNamedChild?.type, instruction).toBe('comment');
        expect(tree.rootNode.firstNamedChild?.text).toBe(instruction);
        expect(tree.rootNode.lastNamedChild?.text).toBe('<p>after</p>');
      } finally {
        tree.delete();
      }
    }
  } finally {
    parser.delete();
  }
});

test('changes target classification incrementally while preserving the following element', () => {
  const parser = new Parser().setLanguage(language);
  const source = '<?xml?><p>after</p>';
  const tree = parser.parse(source)!;
  tree.edit(
    new Edit({
      startIndex: 5,
      oldEndIndex: 5,
      newEndIndex: 6,
      startPosition: { row: 0, column: 5 },
      oldEndPosition: { row: 0, column: 5 },
      newEndPosition: { row: 0, column: 6 },
    })
  );
  const updated = parser.parse('<?xmlx?><p>after</p>', tree)!;
  const fresh = parser.parse('<?xmlx?><p>after</p>')!;
  try {
    expect(updated.rootNode.toString()).toBe(fresh.rootNode.toString());
    expect(updated.rootNode.hasError).toBe(false);
    expect(updated.rootNode.firstNamedChild?.type).toBe('processing_instruction');
    expect(updated.rootNode.lastNamedChild?.text).toBe('<p>after</p>');
  } finally {
    fresh.delete();
    updated.delete();
    tree.delete();
    parser.delete();
  }
});

test('leaves instruction-looking text inside strings and raw elements', () => {
  const parser = new Parser().setLanguage(language);
  try {
    for (const source of [
      '<p title="<?target data?>">after</p>',
      '<script><?target data?></script>',
      '<style><?target data?></style>',
      '<iframe><?target &amp; data?></iframe>',
      '<xmp><?target &amp; data?></xmp>',
      '<noembed><?target &amp; data?></noembed>',
      '<noframes><?target &amp; data?></noframes>',
    ]) {
      const tree = parser.parse(source)!;
      try {
        expect(tree.rootNode.hasError, source).toBe(false);
        expect(tree.rootNode.descendantsOfType('processing_instruction'), source).toHaveLength(0);
        expect(tree.rootNode.firstNamedChild?.text).toBe(source);
      } finally {
        tree.delete();
      }
    }
  } finally {
    parser.delete();
  }
});

test('keeps instruction-looking text in RCDATA and respects closing tags and entities', () => {
  const parser = new Parser().setLanguage(language);
  try {
    for (const tag of ['textarea', 'title']) {
      for (const content of ['<?target data?>tail', '<?target &amp; tail', '<?target incomplete']) {
        const source = `<${tag}>${content}</${tag}><p>after</p>`;
        const tree = parser.parse(source)!;
        try {
          expect(tree.rootNode.hasError, source).toBe(false);
          expect(tree.rootNode.descendantsOfType('processing_instruction'), source).toHaveLength(0);
          expect(tree.rootNode.firstNamedChild?.text).toBe(`<${tag}>${content}</${tag}>`);
          expect(tree.rootNode.lastNamedChild?.text).toBe('<p>after</p>');
          expect(tree.rootNode.descendantsOfType('text')[0]?.text).toBe(content.split('&')[0]);
        } finally {
          tree.delete();
        }
      }
    }
  } finally {
    parser.delete();
  }
});

test('retains an unfinished instruction as an error without losing preceding markup', () => {
  const parser = new Parser().setLanguage(language);
  try {
    for (const suffix of ['<?', '<?target', '<?target?', '<?target data', '<?xml', '<?XML', '<?xml-stylesheet']) {
      const tree = parser.parse(`<p>before</p>${suffix}`)!;
      try {
        expect(tree.rootNode.hasError, suffix).toBe(true);
        expect(tree.rootNode.firstNamedChild?.text).toBe('<p>before</p>');
        expect(tree.rootNode.descendantsOfType('processing_instruction')).toHaveLength(0);
      } finally {
        tree.delete();
      }
    }
  } finally {
    parser.delete();
  }
});

test('preserves instruction-looking plaintext', () => {
  const parser = new Parser().setLanguage(language);
  const tree = parser.parse('<plaintext><?target &amp; data?>')!;
  try {
    expect(tree.rootNode.descendantsOfType('processing_instruction')).toHaveLength(0);
    expect(tree.rootNode.descendantsOfType('text').map((node) => node.text)).toEqual(['<?target &amp; data?>']);
  } finally {
    tree.delete();
    parser.delete();
  }
});

test('preserves reserved and malformed instruction targets in quoted attribute values', () => {
  const parser = new Parser().setLanguage(language);
  try {
    for (const value of ['<?XML?>', '<?xml', '<?xml-stylesheet', '<?1target?>', '<?target:part?>']) {
      for (const quote of ['"', "'"]) {
        const tree = parser.parse(`<p title=${quote}${value}${quote}>after</p>`)!;
        try {
          expect(tree.rootNode.hasError, value).toBe(false);
          expect(tree.rootNode.descendantsOfType('attribute_value').map((node) => node.text)).toEqual([value]);
          expect(tree.rootNode.descendantsOfType('comment')).toHaveLength(0);
          expect(tree.rootNode.descendantsOfType('text').map((node) => node.text)).toEqual(['after']);
        } finally {
          tree.delete();
        }
      }
    }
  } finally {
    parser.delete();
  }
});

test('keeps non-closing markup as text across RCDATA references and raw-text content', () => {
  const parser = new Parser().setLanguage(language);
  try {
    for (const tag of ['textarea', 'title', 'iframe', 'xmp', 'noembed', 'noframes']) {
      for (const content of [
        '<?target <b>tail?>',
        '<?target &amp; <b>tail?>',
        `<?target </${tag}x>tail?>`,
        '<?target <!--tail-->',
      ]) {
        const source = `<${tag}>${content}</${tag}><p>after</p>`;
        const tree = parser.parse(source)!;
        try {
          expect(tree.rootNode.hasError, source).toBe(false);
          expect(tree.rootNode.namedChildCount).toBe(2);
          const element = tree.rootNode.firstNamedChild!;
          expect(element.text).toBe(`<${tag}>${content}</${tag}>`);
          expect(element.namedChildren.filter((node) => node.type === 'element')).toHaveLength(0);
          expect(element.descendantsOfType('processing_instruction')).toHaveLength(0);
          expect(element.descendantsOfType('comment')).toHaveLength(0);
          expect(
            element.namedChildren
              .slice(1, -1)
              .map((node) => node.text)
              .join('')
          ).toBe(content);
          expect(tree.rootNode.lastNamedChild?.text).toBe('<p>after</p>');
        } finally {
          tree.delete();
        }
      }
    }
  } finally {
    parser.delete();
  }
});

test('preserves markup inside foreign title elements and HTML text inside integration points', () => {
  const parser = new Parser().setLanguage(language);
  const query = new Query(language, highlights);
  try {
    for (const [prefix, suffix] of [
      ['<svg>', '</svg>'],
      ['<math>', '</math>'],
      ['<svg><foreignObject><svg>', '</svg></foreignObject></svg>'],
    ]) {
      const source = `${prefix}<title><!--label--><?target?>icon</title>${suffix}<p>after</p>`;
      const tree = parser.parse(source)!;
      try {
        expect(tree.rootNode.hasError, source).toBe(false);
        expect(tree.rootNode.descendantsOfType('comment').map((node) => node.text)).toEqual(['<!--label-->']);
        expect(tree.rootNode.descendantsOfType('processing_instruction').map((node) => node.text)).toEqual([
          '<?target?>',
        ]);
        expect(
          query
            .captures(tree.rootNode)
            .filter((capture) => capture.name === 'comment')
            .map((capture) => capture.node.text)
        ).toEqual(['<!--label-->']);
        expect(tree.rootNode.lastNamedChild?.text).toBe('<p>after</p>');
      } finally {
        tree.delete();
      }
    }
    for (const [prefix, suffix] of [
      ['', ''],
      ['<svg><foreignObject>', '</foreignObject></svg>'],
      ['<svg><desc>', '</desc></svg>'],
      ['<svg><title>', '</title></svg>'],
      ['<math><mtext>', '</mtext></math>'],
    ]) {
      const source = `${prefix}<title><!--label--><?target?>icon</title>${suffix}<p>after</p>`;
      const tree = parser.parse(source)!;
      try {
        expect(tree.rootNode.hasError, source).toBe(false);
        expect(tree.rootNode.descendantsOfType('comment'), source).toHaveLength(0);
        expect(tree.rootNode.descendantsOfType('processing_instruction'), source).toHaveLength(0);
        expect(
          tree.rootNode.descendantsOfType('text').map((node) => node.text),
          source
        ).toContain('<!--label--><?target?>icon');
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

test('bounds recovery work for repeated unfinished instructions and completes them incrementally', () => {
  const parser = new Parser().setLanguage(language);
  const instruction = '<?target '.repeat(5000);
  const source = '<p>before</p>' + instruction;
  let progressChecks = 0;
  const tree = parser.parse(source, undefined, { progressCallback: () => ++progressChecks > 10 });
  try {
    expect(tree).not.toBeNull();
    expect(tree!.rootNode.hasError).toBe(true);
    expect(tree!.rootNode.firstNamedChild?.text).toBe('<p>before</p>');
    expect(tree!.rootNode.endIndex).toBe(source.length);
    tree!.edit(
      new Edit({
        startIndex: source.length,
        oldEndIndex: source.length,
        newEndIndex: source.length + 1,
        startPosition: { row: 0, column: source.length },
        oldEndPosition: { row: 0, column: source.length },
        newEndPosition: { row: 0, column: source.length + 1 },
      })
    );
    const updated = parser.parse(source + '>', tree!);
    try {
      expect(updated!.rootNode.hasError).toBe(false);
      expect(updated!.rootNode.descendantsOfType('processing_instruction').map((node) => node.text)).toEqual([
        instruction + '>',
      ]);
    } finally {
      updated?.delete();
    }
  } finally {
    tree?.delete();
    parser.delete();
  }
});
