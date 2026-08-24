# Shared

This directory contains stable primitives used by more than one subsystem.
Subsystem code remains local until a second consumer appears; it is then promoted
to the nearest shared hierarchy instead of creating a sideways subsystem import.

Dependency direction is one-way: classification, decoding, and other subsystems
may import from `shared`, while `shared` must not import from those subsystems.

## Layout

- `constants/` — canonical values shared across subsystem boundaries;
- `contracts/` — shared types and interfaces;
- `utils/` — stateless helpers with more than one subsystem consumer;
- `index.ts` — the public shared API.

The initial shared primitives define canonical UTF-8 and Windows-1251 labels,
accepted configuration aliases, UTF-8 BOM bytes, encoding selection, and label
normalization for both classification and decoding. Chunking strategy identities
also live here because both indexing decisions and chunking contracts persist them.
The default OpenAI-compatible base URL is shared by embedding and reranking providers.
