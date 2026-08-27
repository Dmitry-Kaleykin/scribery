# Architecture

## Dependency rule

Dependencies point inward:

```text
scribery-core <- scribery-code
scribery-core <- scribery-documents
scribery-core + scribery-code + scribery-documents <- scribery
scribery <- scribery-tui
```

`scribery-core` must never import either product package. Code and document
packages may share persisted build and artifact formats only through core
contracts.

## Runtime composition

`IndexBuildEngine` is product-neutral orchestration. Its caller must inject a
`DocumentProcessingRuntime`, which supplies classification, decoding, parser
lookup, and available chunking strategies.

`scribery-code` composes the code runtime with cAST chunking. The independent
`scribery-documents` runtime composes cAST plus sliding-window chunking. Runtime
identity participates in artifact compatibility, so changing any artifact-
producing capability requires a new runtime identity and cannot silently reuse
incompatible artifacts.

## Product boundaries

### Code

Git state, branches, dirty working trees, project recipes, named retrieval
targets, and branch-aware live indexing are code-product concerns. The TUI owns
the foreground service lifetime, while `scribery-code` owns change detection,
stable build publication, live target naming, and retrieval freshness gates.

### Documents

Documentation, directory synchronization, source tags, and future structured
document extraction are document-product concerns. A directory is a source
adapter rather than the name of the product.
