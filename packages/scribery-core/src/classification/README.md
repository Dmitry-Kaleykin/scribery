# Classification

This directory contains the logic used to classify discovered files before they
are decoded, chunked, embedded, or stored.

Classification describes what a file appears to be. It does not decide whether
the file should be indexed.

## Responsibilities

The classification subsystem is responsible for determining, when possible:

- whether a file is text or binary;
- the file's content type or format;
- the text encoding;
- the programming or markup language;
- whether the file appears generated, minified, or otherwise unusual;
- the confidence of uncertain classifications;
- the evidence used to reach a classification.

Classification results are consumed by indexing policy, decoding, metadata, and
chunking strategy selection.

## Non-responsibilities

The classification subsystem does not:

- discover or traverse files;
- follow symbolic links;
- apply ignore patterns;
- decide whether a file should be indexed;
- decode an entire document;
- split content into chunks;
- generate embeddings;
- store classification results directly.

For example, the classifier may report that a file appears generated, while an
indexing policy decides whether generated files should be excluded.

## Classification inputs

Classification should use available signals such as:

- file extension;
- filename;
- path;
- byte-order mark;
- a sample of the file's bytes;
- shebang;
- modelines or language declarations;
- recognizable content signatures;
- the ratio of printable to non-printable bytes.

No individual signal should always be treated as authoritative.

A file extension is useful evidence, but file contents may contradict it.
An explicit encoding override is different from inferred evidence: it is an
authoritative indexing-configuration decision and must be reported as such.

## Common interface

Classification should expose a common interface similar to:

```ts
export interface FileClassifier {
    classify(input: ClassificationInput): FileClassification;
}

export interface ClassificationInput {
    path: string;
    byteLength: number;
    sample: Uint8Array;
    encodingSelection?: EncodingSelection;
}
```

## Provisional result type

A classification result should contain at least:

```ts
export interface FileClassification {
    contentKind: "text" | "binary" | "unknown";
    format?: string;
    language?: string;
    encoding?: SupportedEncoding;
    confidence: number;
    evidence: ClassificationEvidence[];
    traits: FileTrait[];
}
```

Possible traits include:

- generated;
- minified;
- vendored;
- lockfile;
- configuration;
- documentation;
- test;
- declaration;
- empty.

`confidence` is a finite number from `0` to `1`. Evidence must identify the signal
and the conclusion it supports. An unknown result is valid and must not be coerced
to text merely because a filename has a familiar extension.

The detected `encoding` is advisory input to decoding. The decoder validates it
while reading the full document and may return an unsupported-encoding or
malformed-input error.

Windows-1251 has no byte-order mark and cannot be identified reliably from every
byte sample. A matching path override is authoritative. Otherwise a UTF-8 BOM or a
UTF-8-valid sample provides UTF-8 evidence, but only the decoder validates the
complete input. Windows-1251 is selected only as an explicit override or configured
fallback. Ordered rules, the fallback, and their precedence are part of the hashed
indexing configuration.

## MVP contract

The first implementation includes:

- text, binary, and unknown content-kind classification;
- UTF-8 and UTF-8 byte-order-mark detection plus configured Windows-1251
  overrides/fallback;
- extension, filename, shebang, byte-order-mark, and byte-sample evidence;
- a small language map for initially supported code formats;
- deterministic confidence values and evidence ordering;
- generated, minified, lockfile, configuration, documentation, and test traits.

Encoding fixtures cover UTF-8 with and without a BOM, Windows-1251 Cyrillic text,
ASCII-only input, invalid UTF-8 with the fallback enabled and disabled, and path
override precedence.

The project-focused language map includes PHP (`.php` and `.inc`), Twig, Vue,
CSS, and SCSS in addition to the existing JavaScript, TypeScript, JSON, and HTML
entries. PHP include files use the same canonical `php` language and format as
`.php` files; their original extension remains available from the source path.

Vendored-code detection, modelines, inference of additional legacy encodings, and
probabilistic classifiers are later work.

## Implementation layout

- `constants/` — language maps, binary signatures, content kinds, and trait order;
- `contracts/` — classifier, result, evidence, and signal interfaces;
- `signals/` — independent content/encoding, language, and trait analysis;
- `utils/` — classification-specific path helpers;
- `errors/` — structured invalid-input and unsupported-encoding errors;
- `classifier.ts` — validates input and coordinates signals without applying
  indexing policy;
- `index.ts` — the subsystem's public API;
- `testing/` — deterministic classification fixtures and contract tests.

Encoding primitives shared with decoding live under `../shared/`. New extension,
filename, shebang, binary-signature, or trait constants can be added without
changing classifier coordination logic.
