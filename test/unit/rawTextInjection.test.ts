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

for (const tag of ['script', 'style']) {
  test(`keeps ${tag} content inside slash-suffixed opening tags`, () => {
    const parser = new Parser().setLanguage(language);
    const query = new Query(language, querySource);
    try {
      for (const opener of [`<${tag}>`, `<${tag.toUpperCase()} data-value="a/b">`, `<${tag} data-value=plain >`]) {
        const content = `<${tag}>still raw</${tag}X><b>inside</b>`;
        const suffix = `</${tag}><p>after</p>`;
        const source = opener + content + suffix;
        const insertion = opener.length - 1;
        const updatedSource = source.slice(0, insertion) + '/' + source.slice(insertion);
        const before = parser.parse(source)!;
        before.edit(
          new Edit({
            startIndex: insertion,
            oldEndIndex: insertion,
            newEndIndex: insertion + 1,
            startPosition: { row: 0, column: insertion },
            oldEndPosition: { row: 0, column: insertion },
            newEndPosition: { row: 0, column: insertion + 1 },
          })
        );
        const incremental = parser.parse(updatedSource, before)!;
        const fresh = parser.parse(updatedSource)!;
        try {
          expect(incremental.rootNode.toString()).toBe(fresh.rootNode.toString());
          for (const tree of [fresh, incremental]) {
            expect(tree.rootNode.hasError, updatedSource).toBe(false);
            expect(tree.rootNode.namedChildren.map((node) => node.type)).toEqual([`${tag}_element`, 'element']);
            expect(tree.rootNode.firstNamedChild?.firstNamedChild?.text).toBe(
              updatedSource.slice(0, opener.length + 1)
            );
            expect(tree.rootNode.lastNamedChild?.text).toBe('<p>after</p>');
            expect(
              query.captures(tree.rootNode).map(({ node }) => [node.text, node.startIndex, node.endIndex])
            ).toEqual([[content, opener.length + 1, opener.length + 1 + content.length]]);
          }
        } finally {
          fresh.delete();
          incremental.delete();
          before.delete();
        }
      }
    } finally {
      query.delete();
      parser.delete();
    }
  });
}

test('self-closes foreign raw-element names and retains HTML raw text at integration points', () => {
  const parser = new Parser().setLanguage(language);
  const query = new Query(language, querySource);
  try {
    for (const [prefix, suffix] of [
      ['<svg>', '</svg>'],
      ['<math>', '</math>'],
      ['<svg><foreignObject><svg>', '</svg></foreignObject></svg>'],
    ]) {
      const tree = parser.parse(`${prefix}<script/><style/><path/>${suffix}<p>after</p>`)!;
      try {
        expect(tree.rootNode.hasError).toBe(false);
        expect(tree.rootNode.descendantsOfType('self_closing_tag').map((node) => node.text)).toEqual([
          '<script/>',
          '<style/>',
          '<path/>',
        ]);
        expect(tree.rootNode.lastNamedChild?.text).toBe('<p>after</p>');
        expect(query.captures(tree.rootNode)).toHaveLength(0);
      } finally {
        tree.delete();
      }
    }
    for (const [prefix, suffix] of [
      ['<svg><foreignObject>', '</foreignObject></svg>'],
      ['<math><mtext>', '</mtext></math>'],
      ['<math><annotation-xml><svg><foreignObject>', '</foreignObject></svg></annotation-xml></math>'],
      [
        '<math><annotation-xml encoding="application/xml"><svg><foreignObject>',
        '</foreignObject></svg></annotation-xml></math>',
      ],
    ]) {
      const tree = parser.parse(`${prefix}<script/>let a = 1;</script>${suffix}<p>after</p>`)!;
      try {
        expect(tree.rootNode.hasError).toBe(false);
        expect(tree.rootNode.lastNamedChild?.text).toBe('<p>after</p>');
        expect(query.captures(tree.rootNode).map(({ node }) => node.text)).toEqual(['let a = 1;']);
      } finally {
        tree.delete();
      }
    }
  } finally {
    query.delete();
    parser.delete();
  }
});

test('retains raw content at encoding-dependent MathML integration points', () => {
  const parser = new Parser().setLanguage(language);
  const query = new Query(language, querySource);
  try {
    for (const attributes of [
      'encoding="text/html"',
      "ENCODING = 'APPLICATION/XHTML+XML'",
      'id=x encoding=text/html',
      'encoding="text&sol;html"',
      'encoding="application&#x2F;xhtml&plus;xml"',
      'encoding="t&#00000000000000000000000000101;xt/html"',
      'encoding="text/html" encoding="application/xml"',
    ]) {
      const source = `<math><annotation-xml ${attributes}><script/>if(a<b)c()</script><style/>a>b{color:red}</style></annotation-xml></math><p>after</p>`;
      const tree = parser.parse(source)!;
      try {
        expect(tree.rootNode.hasError, source).toBe(false);
        expect(tree.rootNode.lastNamedChild?.text).toBe('<p>after</p>');
        expect(query.captures(tree.rootNode).map(({ node }) => node.text)).toEqual(['if(a<b)c()', 'a>b{color:red}']);
      } finally {
        tree.delete();
      }
    }
    for (const attributes of [
      '',
      'encoding="application/xml"',
      'encoding="text/html "',
      'encoding=text/html/',
      'encoding="application/xml" encoding="text/html"',
      'encoding encoding="text/html"',
    ]) {
      const source = `<math><annotation-xml ${attributes}><script/><style/></annotation-xml></math><p>after</p>`;
      const tree = parser.parse(source)!;
      try {
        expect(tree.rootNode.hasError, source).toBe(false);
        expect(tree.rootNode.lastNamedChild?.text).toBe('<p>after</p>');
        expect(tree.rootNode.descendantsOfType('self_closing_tag')).toHaveLength(2);
        expect(query.captures(tree.rootNode)).toHaveLength(0);
      } finally {
        tree.delete();
      }
    }
    const source =
      '<math><annotation-xml encoding="text/html"><script/>body</script></annotation-xml></math><p>after</p>';
    const start = source.indexOf('text/html');
    const before = parser.parse(source)!;
    const replacement = 'application/xml';
    before.edit(
      new Edit({
        startIndex: start,
        oldEndIndex: start + 'text/html'.length,
        newEndIndex: start + replacement.length,
        startPosition: { row: 0, column: start },
        oldEndPosition: { row: 0, column: start + 'text/html'.length },
        newEndPosition: { row: 0, column: start + replacement.length },
      })
    );
    const updatedSource = source.replace('text/html', replacement);
    const incremental = parser.parse(updatedSource, before)!;
    const fresh = parser.parse(updatedSource)!;
    try {
      expect(incremental.rootNode.toString()).toBe(fresh.rootNode.toString());
      expect(incremental.rootNode.hasError).toBe(false);
      expect(incremental.rootNode.lastNamedChild?.text).toBe('<p>after</p>');
      expect(query.captures(incremental.rootNode)).toHaveLength(0);
    } finally {
      before.delete();
      incremental.delete();
      fresh.delete();
    }
  } finally {
    query.delete();
    parser.delete();
  }
});

test('retains complete foreign raw-element content and distinguishes slashes in attribute values', () => {
  const parser = new Parser().setLanguage(language);
  const query = new Query(language, querySource);
  try {
    for (const tag of ['script', 'style']) {
      const content = '<![CDATA[if(a<b)c()]]>';
      for (const attributes of ['', ' data-value=path/', ' data-value="path/"']) {
        const source = `<svg><${tag}${attributes}>${content}</${tag}></svg><p>after</p>`;
        const tree = parser.parse(source)!;
        try {
          expect(tree.rootNode.hasError, source).toBe(false);
          expect(tree.rootNode.lastNamedChild?.text).toBe('<p>after</p>');
          expect(query.captures(tree.rootNode).map(({ node }) => node.text)).toEqual([content]);
          if (attributes) {
            expect(tree.rootNode.descendantsOfType('attribute_value').map((node) => node.text)).toEqual(['path/']);
          }
        } finally {
          tree.delete();
        }
      }
    }
    const tree = parser.parse('<svg><script data-value=path /><style data-value="path/"/></svg><p>after</p>')!;
    try {
      expect(tree.rootNode.hasError).toBe(false);
      expect(tree.rootNode.descendantsOfType('self_closing_tag')).toHaveLength(2);
      expect(tree.rootNode.lastNamedChild?.text).toBe('<p>after</p>');
      expect(query.captures(tree.rootNode)).toHaveLength(0);
    } finally {
      tree.delete();
    }
  } finally {
    query.delete();
    parser.delete();
  }
});
