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

## Compatibility-first migration

The first milestone preserves the behavior of the reference implementations
while establishing package ownership. Public compatibility is provided by the
`scribery` facade, which re-exports the three library packages and hosts the CLI
and MCP binaries.

The core build engine currently ships the established classifier and parser
registry so the migration does not change chunk identities. A later internal
step will inject the document-processing runtime into the engine. That change
must preserve artifact compatibility identities or explicitly version them.

## Product boundaries

### Code

Git state, branches, dirty working trees, project recipes, named retrieval
targets, and future live indexing are code-product concerns.

### Documents

Collections, directory synchronization, source tags, and future structured
document extraction are document-product concerns. A directory is a source
adapter rather than the name of the product.

