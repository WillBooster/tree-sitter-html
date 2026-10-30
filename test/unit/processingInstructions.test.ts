import path from 'node:path';

import { Language, Parser } from '@willbooster/web-tree-sitter';
import { expect, test } from 'vitest';

await Parser.init();
const language = await Language.load(path.join(import.meta.dirname, '../../tree-sitter-html.wasm'));

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
    const tree = parser.parse(`<div><br>${instruction}<p>after</p></div>`)!;
    try {
      expect(tree.rootNode.hasError).toBe(false);
      const node = tree.rootNode.descendantsOfType('processing_instruction')[0];
      expect(node?.text).toBe(instruction);
      expect(node?.parent?.type).toBe('element');
      expect(node?.parent?.firstNamedChild?.text).toBe('<div>');
      expect(node?.previousNamedSibling?.text).toBe('<br>');
      expect(node?.nextNamedSibling?.text).toBe('<p>after</p>');
    } finally {
      tree.delete();
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

test('classifies an extended xml target as an instruction while preserving the following element', () => {
  const parser = new Parser().setLanguage(language);
  const tree = parser.parse('<?xmlx?><p>after</p>')!;
  try {
    expect(tree.rootNode.hasError).toBe(false);
    expect(tree.rootNode.firstNamedChild?.type).toBe('processing_instruction');
    expect(tree.rootNode.lastNamedChild?.text).toBe('<p>after</p>');
  } finally {
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
  try {
    for (const [prefix, suffix] of [
      ['<svg>', '</svg>'],
      ['<math>', '</math>'],
      ['<svg><foreignObject><svg>', '</svg></foreignObject></svg>'],
      ['<svg><foreıgnObject>', '</foreıgnObject></svg>'],
      ['<svg><foreŉgnObject>', '</foreŉgnObject></svg>'],
      ['<math><mı>', '</mı></math>'],
      ['<math><mſ>', '</mſ></math>'],
    ]) {
      const source = `${prefix}<title><!--label--><?target?>icon</title>${suffix}<p>after</p>`;
      const tree = parser.parse(source)!;
      try {
        expect(tree.rootNode.hasError, source).toBe(false);
        expect(tree.rootNode.descendantsOfType('comment').map((node) => node.text)).toEqual(['<!--label-->']);
        expect(tree.rootNode.descendantsOfType('processing_instruction').map((node) => node.text)).toEqual([
          '<?target?>',
        ]);
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
    parser.delete();
  }
});

test('bounds recovery work for repeated unfinished instructions and parses them once completed', () => {
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
    const completed = parser.parse(source + '>')!;
    try {
      expect(completed.rootNode.hasError).toBe(false);
      expect(completed.rootNode.descendantsOfType('processing_instruction').map((node) => node.text)).toEqual([
        instruction + '>',
      ]);
    } finally {
      completed.delete();
    }
  } finally {
    tree?.delete();
    parser.delete();
  }
});

test('retains foreign text context after deep ancestors exceed scanner storage', () => {
  const parser = new Parser().setLanguage(language);
  try {
    for (const [prefix, suffix] of [
      ['<svg>', '</svg>'],
      ['<math>', '</math>'],
      ['<svg><foreignObject><svg>', '</svg></foreignObject></svg>'],
    ]) {
      const source = `${prefix}${'<g><g-x>'.repeat(200)}<title><!--label--><?target?>icon</title>${'</g-x></g>'.repeat(200)}${suffix}<title><!--html--><?html?>tail</title><textarea><!--textarea-->tail</textarea><p>after</p>`;
      const tree = parser.parse(source)!;
      try {
        expect(tree.rootNode.descendantsOfType('comment').map((node) => node.text)).toEqual(['<!--label-->']);
        expect(tree.rootNode.descendantsOfType('processing_instruction').map((node) => node.text)).toEqual([
          '<?target?>',
        ]);
        expect(tree.rootNode.lastNamedChild?.text).toBe('<p>after</p>');
        expect(tree.rootNode.descendantsOfType('text').map((node) => node.text)).toEqual([
          'icon',
          '<!--html--><?html?>tail',
          '<!--textarea-->tail',
          'after',
        ]);
        const renamed = parser.parse(source.replace('label', 'other'))!;
        try {
          expect(renamed.rootNode.descendantsOfType('comment').map((node) => node.text)).toEqual(['<!--other-->']);
        } finally {
          renamed.delete();
        }
      } finally {
        tree.delete();
      }
    }
  } finally {
    parser.delete();
  }
});

test('ends text elements only at ASCII-matching closing names', () => {
  const parser = new Parser().setLanguage(language);
  try {
    for (const [tag, lookalike] of [
      ['title', 'tıtle'],
      ['title', 'tŉtle'],
      ['iframe', 'ıframe'],
      ['noframes', 'noframeſ'],
    ]) {
      const content = `before</${lookalike}>&amp;<?target?>after`;
      const source = `<${tag}>${content}</${tag!.toUpperCase()}><p>following</p>`;
      const tree = parser.parse(source)!;
      try {
        expect(tree.rootNode.hasError, source).toBe(false);
        expect(tree.rootNode.namedChildCount, source).toBe(2);
        expect(tree.rootNode.firstNamedChild?.text, source).toBe(`<${tag}>${content}</${tag!.toUpperCase()}>`);
        expect(tree.rootNode.descendantsOfType('processing_instruction'), source).toHaveLength(0);
        expect(tree.rootNode.descendantsOfType('erroneous_end_tag'), source).toHaveLength(0);
        expect(tree.rootNode.lastNamedChild?.text, source).toBe('<p>following</p>');
      } finally {
        tree.delete();
      }
    }
  } finally {
    parser.delete();
  }
});

test('keeps Unicode lookalike element names out of text-only modes', () => {
  const parser = new Parser().setLanguage(language);
  try {
    for (const tag of ['tıtle', 'tŉtle', 'noframeſ', 'tıtlé']) {
      const source = `<${tag}><?target?></${tag}><p>following</p>`;
      const tree = parser.parse(source)!;
      try {
        expect(tree.rootNode.hasError, source).toBe(false);
        expect(tree.rootNode.namedChildCount, source).toBe(2);
        expect(tree.rootNode.firstNamedChild?.text, source).toBe(`<${tag}><?target?></${tag}>`);
        expect(
          tree.rootNode.descendantsOfType('processing_instruction').map((node) => node.text),
          source
        ).toEqual(['<?target?>']);
        expect(tree.rootNode.lastNamedChild?.text, source).toBe('<p>following</p>');
      } finally {
        tree.delete();
      }
    }
  } finally {
    parser.delete();
  }
});
