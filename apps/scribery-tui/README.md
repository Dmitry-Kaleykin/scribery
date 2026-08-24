# scribery-tui

Interactive terminal interface for Scribery. This is the maintained UI in the
monorepo; the abandoned web UI is not part of Scribery.

Provider profiles and indexing presets offer both guided editing and an
advanced `Edit JSON` action. JSON editing uses `$VISUAL`, then `$EDITOR`, then
`micro`, with `nano` as the final fallback. Scribery validates the edited item
before applying it atomically; names remain managed by the separate rename
action, and profile API keys never appear in the temporary JSON file.
