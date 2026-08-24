# Scribery

Scribery is a local-first indexing and semantic-retrieval monorepo. It separates
the shared build and retrieval engine from the two products that compose it:
Git-aware code retrieval and managed document collections.

```text
                         scribery-core
                         /           \
             scribery-code           scribery-documents
                         \           /
                          scribery CLI/MCP
                                |
                           scribery-tui
```

## Packages

- `scribery-core` owns immutable snapshots and builds, metadata, storage,
  embeddings, reranking, generic discovery, decoding, chunking, and retrieval.
- `scribery-code` owns Git working trees, code indexing policy, managed projects,
  indexing recipes, retrieval targets, and branch-aware live indexing.
- `scribery-documents` owns managed collections, document sources, tags, and the
  text-and-code collection policy.
- `scribery` composes both products into the command-line and MCP interfaces.
- `scribery-tui` is the interactive terminal application.

The previous `the-blue-scribes` and `the-blue-scribes-tui` repositories are
reference implementations. They are not modified or imported by this workspace.

PDF and DOCX extraction is intentionally out of scope for the initial migration.
Binary document formats will later enter through an explicit extractor contract,
not through the text decoder.

## Development

```sh
npm install
npm run build
npm test
```
