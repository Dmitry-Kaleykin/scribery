# Decoding

This directory contains byte-to-text decoding for files accepted by indexing
policy.

Classification supplies encoding evidence. Indexing configuration may resolve a
path override or allow fallback. Decoding makes the final selection while reading
the complete file and produces the canonical JavaScript string consumed by
metadata, chunking, embedding, and storage.

## Responsibilities

The decoding subsystem is responsible for:

- reading an accepted file through an injected byte source;
- enforcing configured byte limits while reading;
- removing a byte-order mark when appropriate;
- decoding bytes with the selected encoding;
- applying the configured malformed-input policy;
- returning decoded content and decoding diagnostics;
- preserving cancellation and I/O errors as structured failures.

It does not discover files, infer the encoding, decide whether a file should be
indexed, normalize line endings, chunk text, or store content.

## Content preservation

The returned `content` is canonical for downstream source positions. Decoding must
not normalize newlines, trim whitespace, apply Unicode normalization, or otherwise
rewrite text.

"Preserve original text" in downstream contracts means preserving this decoded
string exactly. The source byte hash separately preserves the identity of the
original bytes.

## Common interface

```ts
export interface DocumentDecoder {
    decode(
        input: DecodingInput,
        options?: DecodingOptions,
    ): Promise<DecodedDocument>;
}

export interface DecodingInput {
    path: string;
    encodingSelection: EncodingSelection;
    bytes: ByteSource;
}

export type SupportedEncoding = "utf-8" | "windows-1251";
export type EncodingLabel =
    | SupportedEncoding
    | "utf8"
    | "windows1251"
    | "cp1251"
    | "win1251";
export type Windows1251EncodingLabel =
    | "windows-1251"
    | "windows1251"
    | "cp1251"
    | "win1251";

export interface EncodingSelection {
    override?: EncodingLabel;
    fallback?: Windows1251EncodingLabel;
}

export interface DecodedDocument {
    content: string;
    encoding: SupportedEncoding;
    byteLength: number;
    diagnostics: DecodingDiagnostic[];
}
```

`ByteSource` is an application interface that allows bounded reads and
cancellation without coupling decoding to a particular filesystem API.

## Malformed input

Malformed byte sequences must not be replaced silently. The initial default is
strict decoding: return a structured error that identifies the path and encoding
without including the complete content.

A future replacement mode may emit U+FFFD only when explicitly configured and must
report that replacement occurred.

## Supported encodings

The MVP supports the canonical encoding labels `utf-8` and `windows-1251`. UTF-8
may include a byte-order mark, which is removed before constructing canonical
content. Windows-1251 has no byte-order mark, so arbitrary bytes cannot identify it
reliably.

The indexing coordinator resolves the ordered path rules to at most one `override`
before calling the decoder. Encoding selection is then deterministic. The initial
precedence is:

1. the resolved path override;
2. a UTF-8 byte-order mark;
3. strict validation of the complete input as UTF-8;
4. a configured Windows-1251 fallback;
5. otherwise, an unsupported-encoding error.

The ordered overrides and fallback are part of the hashed indexing configuration.
The selected encoding and the evidence or rule that selected it are recorded. This
allows mixed repositories to define Windows-1251 directory or file patterns and
prevents a probabilistic guess from changing a build between runs. A byte sample
may provide classification evidence, but the decoder validates the complete input
before returning content.

Aliases may be accepted at configuration boundaries, but they are normalized
before hashing build configuration or writing metadata. UTF-16 and other legacy
encodings may be added with fixtures that verify byte-order marks, malformed input,
source hashing, and exact decoded output.

## MVP contract

The first implementation includes:

- strict UTF-8 and Windows-1251 decoding;
- canonical encoding labels and deterministic per-path/fallback selection;
- configurable maximum byte size;
- exact newline and whitespace preservation;
- cancellation;
- structured unsupported-encoding, malformed-input, and I/O errors.

Fixtures must include UTF-8 with and without a BOM, Windows-1251 Cyrillic text,
ASCII-only ambiguous input, malformed UTF-8, override precedence, fallback
disabled, CRLF preservation, and two differently encoded files in one build.

Streaming text output, replacement decoding, UTF-16, and other legacy encodings are
later work.

## Implementation layout

- `constants/` — decoding-specific default limits;
- `contracts/` — decoder and byte-source interfaces;
- `decoders/` — strict UTF-8 and Windows-1251 implementations;
- `errors/` — structured decoding failures;
- `utils/` — byte collection, label normalization, and cancellation helpers;
- `decode-document.ts` — applies override/validation/fallback precedence;
- `index.ts` — the subsystem's public API;
- `testing/` — deterministic byte source and decoding contract tests.

Canonical encoding labels, aliases, BOM bytes, and label normalization live under
`../shared/` because both decoding and classification consume them. Decoding
re-exports them through its public API for existing consumers.
