# Compiler Notebook

A VS Code extension that gives compiled languages a Jupyter-like notebook
experience: Markdown prose interleaved with source-file cells that compile and
run in one click, in a fresh isolated temp dir. Not a REPL — no state carries
between runs.

See [CLAUDE.md](CLAUDE.md) for the full design.

## Status — phase 1

- `.cnb` JSON notebook format (`NotebookSerializer`), metadata round-trips.
- A `NotebookController` that treats the whole notebook as one project, builds
  every `cpp` cell with a hardcoded `g++`, and streams compiler and program
  output into the cell.
- Filename resolution (`metadata.filename` → `// @file x.cpp` → auto-generated),
  collision auto-suffixing, header cells excluded from compile inputs.
- Cancellation kills the child process; temp dirs are always cleaned up.

Buildspec (`toml`) cells are recognised by the resolver but do not yet open
projects — that's phase 2.

## Develop

Needs Node 20+ (`vsce` and the test runner both assume it); `.nvmrc` pins 22.

```sh
nvm use             # honours .nvmrc
npm install
npm run compile     # or: npm run watch
npm test            # unit tests for the pure resolver
```

Press <kbd>F5</kbd> to launch the Extension Development Host, then open
`examples/hello.cnb` and run the C++ cell.

Packaging:

```sh
npm run package     # → compiler-notebook-<version>.vsix
code --install-extension compiler-notebook-0.0.1.vsix
```

> Installing over an already-open `.cnb` tab is not enough: a reloaded window
> restores that tab in whatever editor it was using. Close the tab and reopen the
> file, or use **Open With… → Compiler Notebook**.

## Layout

| File | Role |
| --- | --- |
| `src/model.ts` | Types, defaults, notebook/language constants. No `vscode` import. |
| `src/languages.ts` | The single per-language config table. |
| `src/project.ts` | Pure project resolver + filename resolution. Unit-tested. |
| `src/build.ts` | Temp-dir assembly, compile, run, cancellation. No `vscode` import. |
| `src/serializer.ts` | `.cnb` ⇄ `NotebookData`. |
| `src/controller.ts` | The kernel: resolve → dedupe → build → stream output. |
