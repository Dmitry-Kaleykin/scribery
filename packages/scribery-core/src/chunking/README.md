# Chunking

This directory contains the strategies used to split documents into chunks suitable
for embedding, storage, and retrieval.

Each chunking strategy must have its own implementation file. Shared types,
strategy selection, constants and utilities may live in separate files.

## Responsibilities

The chunking subsystem is responsible for:

- splitting a document into meaningful chunks;
- preserving the original text exactly;
- recording where each chunk came from;
- respecting configurable size limits where possible;
- keeping meaningful structures together, such as paragraphs, functions, classes,
  and methods;
- returning chunks in source order.

It is not responsible for:

- reading files from disk;
- deciding whether a file should be indexed;
- generating embeddings;
- storing chunks;
- generating globally unique database IDs;
- ranking retrieved chunks.

"Preserving the original text" means that concatenated, non-overlapping chunk
ranges refer to exact substrings of the decoded document. A strategy must not trim,
normalize, or otherwise rewrite `chunk.content`.

This source-preservation contract applies to chunking output. The indexing
boundary may omit a whitespace-only or explicitly non-searchable structural
fragment because it has no independent retrieval value; meaningful chunks are
still stored verbatim.

## Strategy selection

A strategy is selected using information discovered during file classification.

Strategy identities:

- `cast` — the initial code strategy;
- `sliding-window` — overlapping, boundary-aware chunks for managed plain text.

Binary and unsupported files must not be passed to a chunking strategy.

The cAST strategy follows the recursive split-and-merge algorithm described in
[cAST: Enhancing Code Retrieval-Augmented Generation with Structural Chunking via
Abstract Syntax Tree](https://aclanthology.org/2025.findings-emnlp.430/): parse the
file into an AST, recursively replace nodes that exceed the configured chunk size
with their children, then greedily merge adjacent sibling nodes while the merged
source range remains within the limit. Source text between nodes, including
comments and whitespace, remains part of the corresponding contiguous range.

`CastChunkingStrategy` implements this algorithm iteratively so deeply nested
normalized trees do not add JavaScript call-stack depth. It receives a
`ParserRegistry` through its constructor; parser configuration therefore remains
outside the language-invariant strategy:

```ts
const strategy = new CastChunkingStrategy(parserRegistry);
const chunks = await strategy.chunk(document, options);
```

When an oversized node is replaced by its children, cAST assigns the complete
parent range to contiguous child envelopes. Prefixes, suffixes, comments,
punctuation, and whitespace between AST nodes therefore belong to exactly one
chunk. Concatenating `chunk.content` always reconstructs the decoded document
verbatim. A leaf with no smaller AST boundary remains one explicitly oversized
chunk; cAST does not silently switch to fixed-size, line-based, or sliding-window
splitting. A chunk representing one node records that node type as `kind`; a
chunk formed by merging multiple siblings leaves `kind` unset.

Some syntax trees expose whitespace-only children at the boundary of an
oversized parent. Their contiguous envelopes can otherwise become isolated
opening tags, closing tags, delimiters, or trivia. A language-independent
compaction pass tracks this boundary provenance and merges prefixes forward,
suffixes backward, and neutral separators into the smallest compatible
neighbor. It preserves exact source coverage and the configured maximum size;
an already oversized indivisible neighbor may absorb its own boundary. Residue
that neither neighbor can absorb remains in chunking output with
`searchable: false` so exact coverage is retained without embedding it.

After boundary compaction, cAST performs a conservative dangling-prefix pass.
A fragment is merged forward only when it is at most 20% of the configured
maximum size (capped at 200 UTF-16 code units), ends in a continuation marker
such as `,`, `=>`, `=`, `{`, `(`, `[`, or `:`, and the combined fragment remains
within the maximum. Complete short constructs and large prefixes are left
unchanged. This keeps call headers, function headers, and similar continuations
with useful body content without applying a blanket minimum chunk size.

When such a prefix precedes an oversized AST child, cAST carries the prefix into
that child's recursive split envelope instead of emitting it first. Greedy
sibling grouping therefore reserves room for the prefix and moves whole
AST-aligned children into later chunks as necessary. This preserves the strict
configured maximum and avoids standalone declaration, assignment, call, array,
and function prefixes without using arbitrary text boundaries.

The implementation may use Tree-sitter when it provides the required language
coverage and stable source ranges. Parser selection remains an implementation
detail behind the strategy interface. Every code language accepted by initial
indexing policy must have a configured parser. An unsupported language or parse
failure produces a structured diagnostic and follows indexing failure policy; it
must not silently fall back to line-based or sliding-window chunking.

Project Markdown uses an MDAST parser with GitHub-Flavored Markdown extensions.
Top-level headings become nested section nodes so each heading remains in the
source envelope of the material it introduces. Lists, block quotes, tables,
links, task items, fenced code, and other Markdown constructs retain exact UTF-16
source ranges. Multiline leaf constructs expose physical line children so a long
fenced block can still be split without replacing structural parsing with a
sliding window.

## Common interface

All strategies should implement a common interface:

```ts
export interface ChunkingStrategy {
    readonly id: ChunkingStrategyId;

    chunk(
        document: ChunkingDocument,
        options: ChunkingOptions,
    ): Promise<Chunk[]>;
}
```

`ChunkingOptions` includes an optional `AbortSignal`. A promise-based interface is
the initial contract because parser initialization may be asynchronous and
chunking must support cancellation. Strategies still return a complete ordered
array for one document; whole-repository streaming belongs to the indexing
coordinator.

The initial size unit is UTF-16 code units and is explicit in options:

```ts
export interface ChunkingOptions {
    maximumSize: number;
    sizeUnit: "utf16-code-units";
    signal?: AbortSignal;
}
```

New size units require an explicit contract value; strategies must not silently
interpret the same numeric limit as characters, bytes, or tokens.

## Parser adapters

Parser adapters receive canonical decoded `ChunkingDocument` content and return a
normalized syntax tree. Normalized nodes contain a non-empty type, a canonical
metadata `SourceRange`, and ordered child nodes. The root covers the complete
non-empty document; children fit within their parent and do not overlap.

`ParserRegistry` selects an adapter by canonical language and format. An exact
language-and-format target wins over a language-only fallback. Duplicate parser
IDs or targets are rejected, and an unsupported target never falls back to a line
or sliding-window parser.

The concrete adapters are `TypeScriptParser`, `PythonParser`, `PhpParser`,
`StylesheetParser`, `HtmlParser`, `JsonParser`, `VueParser`, and `TwigParser`.
`TypeScriptParser` supports the exact classification targets
`typescript`, `typescript-jsx`, `javascript`, and `javascript-jsx`. It uses the
official TypeScript 6 compatibility compiler API for in-memory parsing while the
project itself continues to typecheck with the native TypeScript 7 compiler. The
two dependencies are deliberately isolated because TypeScript 7.0 does not yet
provide a stable direct parsing API. Normalization excludes punctuation-token
nodes such as `EqualsGreaterThanToken`; their exact text remains in the
surrounding source envelope so punctuation cannot become an independent chunk.
Identifiers, literals, and structural nodes remain available to cAST.

`PythonParser` supports `python` and `python-stub`. It uses the Python grammar and
WASM runtime shipped by `@vscode/tree-sitter-wasm`, so parser setup does not
depend on a platform-specific native addon or local compiler toolchain. The
shared `TreeSitterParserAdapter` owns lazy runtime and grammar initialization,
syntax-error handling, cancellation checks, resource disposal, and normalized
named-node traversal. Future Tree-sitter adapters only need parser-local targets,
an identity, and a grammar WASM filename.

`PhpParser` supports the canonical `php` target used by both `.php` and `.inc`
files. The PHP grammar also preserves structural PHP nodes inside files containing
surrounding HTML. Source extensions remain classification and provenance data;
they do not require duplicate parser targets when the syntax is identical.

`StylesheetParser` supports the exact `css` and `scss` targets. It uses PostCSS's
CSS parser for strict CSS and the PostCSS SCSS syntax for variables, mixins,
includes, nested selectors, and other SCSS structure. Both syntaxes normalize
rules, declarations, comments, and at-rules into canonical source ranges without
including source text in parse diagnostics.

TypeScript AST offsets and the selected Tree-sitter WASM runtime's JavaScript
indices are already UTF-16 code-unit offsets. All adapters derive every normalized
range through `SourcePositionIndex`, reject syntax diagnostics with a structured
`parser-failure`, and do not include decoded source content in diagnostics.
`HtmlParser` uses a location-aware HTML syntax tree. `JsonParser` requires strict
JSON before normalizing its tree. `VueParser` combines the HTML document tree with
JavaScript or TypeScript trees from script blocks, while `TwigParser` combines
the HTML tree with location-preserving Twig delimiter nodes. Vue and Twig template
markup uses parse5's recovery mode because framework directives, slot syntax, and
Twig expressions are not required to be conforming HTML. Recovery removes parser
artifacts whose source ranges overlap or escape their parent while retaining exact
source coverage. Embedded Vue scripts and unclosed Twig delimiters remain strict
parser failures.

`createInitialParserRegistry()` returns a fresh registry containing all eight
adapters. Other language parsers can be added without changing registry or
strategy behavior.

Many native parsers report UTF-8 byte offsets. `ParserSourceMap` converts those
offsets to UTF-16 and creates canonical source ranges. It rejects offsets inside a
UTF-8 sequence, UTF-16 surrogate-pair splits, out-of-bounds offsets, and unpaired
source surrogates. Raw parser offsets must not appear in a normalized syntax tree.

The coordinator can derive the current indexing-policy capability without another
language registry:

```ts
const capabilities = {
    canChunkWithCast: parserRegistry.canParse({ language, format }),
};
```

## Source positions

Every chunk range follows the canonical conventions in
[metadata](../metadata/README.md#source-positions): zero-based UTF-16 offsets with
an exclusive end offset, and one-based inclusive line numbers.

cAST operates on the canonical decoded string, independent of whether its source
bytes were UTF-8 or Windows-1251. Parser byte, row, or column positions are
implementation details and must be translated back to canonical UTF-16 offsets.
They must never be persisted directly.

For every returned chunk:

- `content === document.content.slice(startOffset, endOffset)`;
- `startOffset < endOffset`;
- ranges are ordered by `startOffset`;
- overlap occurs only when the selected strategy explicitly allows it;
- line numbers are derived from the same decoded content.

## MVP contract

The first implementation includes:

- one deterministic cAST strategy for every code language accepted by the initial
  indexing policy;
- recursive splitting of oversized AST nodes and greedy merging of adjacent
  siblings up to a configurable size limit;
- exact coverage of comments and inter-node whitespace;
- structured unsupported-parser and parse-failure diagnostics, with no silent
  sliding-window fallback;
- exact content and source-range preservation;
- cancellation;
- fixtures covering CRLF, LF, Unicode surrogate pairs, oversized AST nodes,
  comments, malformed code, and equivalent UTF-8 and Windows-1251 source files.

Richer symbol metadata, parser recovery beyond the configured failure policy, and
streaming one document are later work.

## Implemented foundation layout

- `constants/` — explicit chunk-size units;
- `contracts/` — chunk, strategy, parser, and normalized-tree contracts;
- `parsers/registry.ts` — deterministic exact/fallback parser selection;
- `parsers/parser-source-map.ts` — parser-byte to canonical-range conversion;
- `parsers/utf8-byte-offset-index.ts` — bidirectional UTF-8/UTF-16 boundaries;
- `parsers/tree-sitter/` — shared WASM runtime loading, parser lifecycle,
  diagnostics, cancellation, and named-node normalization;
- `parsers/python/` — the Python and Python-stub Tree-sitter adapter, with
  parser-local constants;
- `parsers/php/` — the PHP and PHP-include Tree-sitter adapter, with parser-local
  constants;
- `parsers/stylesheet/` — the PostCSS CSS and SCSS adapter, normalization, and
  parser-local constants;
- `parsers/html/` — the location-aware HTML adapter;
- `parsers/json/` — the strict JSON adapter;
- `parsers/vue/` — the composite Vue and embedded-script adapter;
- `parsers/twig/` — the composite HTML and Twig adapter;
- `parsers/typescript/` — the TypeScript, TSX, JavaScript, and JSX adapter, with
  parser-local constants and utilities;
- `parsers/initial-registry.ts` — the initial configured parser set;
- `strategies/cast.ts` — iterative recursive splitting, greedy sibling merging,
  and exact source-envelope preservation;
- `strategies/sliding-window.ts` — deterministic paragraph/newline-aware text
  windows with explicit overlap and surrogate-safe UTF-16 boundaries;
- `validation/` — chunking-document and normalized-tree validation;
- `errors/` — stable structured parser and chunking errors;
- `index.ts` — the currently implemented chunking public API;
- `testing/` — fake adapters, registry behavior, tree validation, and Unicode
  offset fixtures.

Additional language adapters remain incremental chunking extensions.
