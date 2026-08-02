# Compiler Notebook

A VS Code extension that gives compiled languages a Jupyter-like notebook
experience: Markdown prose interleaved with source-file cells that compile and
run in one click, in a fresh isolated temp dir. Not a REPL — no state carries
between runs.

See [CLAUDE.md](CLAUDE.md) for the full design.

## Status — phase 2

- `.cnb` JSON notebook format (`NotebookSerializer`), metadata round-trips.
- **Buildspec cells**: a `toml` cell opens a project and configures it. All four
  keys are optional; unknown keys and bad values warn instead of failing.

  ```toml
  compiler = "g++"              # default: from the project's language
  flags    = ["-std=c++23", "-O2"]
  mode     = "run"              # "build" | "run"
  output   = "app"
  ```

- **Positional project resolution**: a project is one buildspec cell plus the
  file cells below it, up to the next buildspec cell. Markdown cells in between
  do not break a project. File cells above the first buildspec get a soft
  diagnostic and are not built.
- Running *any* cell builds its owning project; distinct projects are built once
  each, and output always lands on the project's buildspec cell.
- Filename resolution (`metadata.filename` → `// @file x.cpp` → auto-generated),
  collision auto-suffixing (scoped per project), header cells excluded from
  compile inputs.
- Cancellation kills the child process; temp dirs are always cleaned up.

Next up (phase 4): diagnostics move onto a `DiagnosticCollection` and filenames
get a cell status bar item. Today warnings are printed into the build output.

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
| `src/buildspec.ts` | Tolerant TOML subset parser + spec defaulting. No `vscode` import. |
| `src/project.ts` | Pure project resolver + filename resolution. Unit-tested. |
| `src/build.ts` | Temp-dir assembly, compile, run, cancellation. No `vscode` import. |
| `src/serializer.ts` | `.cnb` ⇄ `NotebookData`. |
| `src/controller.ts` | The kernel: resolve → dedupe → build → stream output. |
