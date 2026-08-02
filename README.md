# Compiler Notebook

A VS Code extension that gives compiled languages a Jupyter-like notebook
experience: Markdown prose interleaved with source-file cells that compile and
run in one click, in a fresh isolated temp dir. Not a REPL — no state carries
between runs.

See [CLAUDE.md](CLAUDE.md) for the full design.

## Status — phase 4

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
  collision auto-suffixing scoped per project.
- **Multi-file build dirs**: sub-directories in a filename (`src/util.cpp`) are
  created; names that would escape the build dir are reduced to their base name
  and reported. Only translation units go on the compiler command line, so
  headers and **asset cells** — a cell of any language with an explicit filename,
  e.g. a `json` fixture — are written to the build dir but never compiled.
- Cancellation kills the child process; temp dirs are always cleaned up.
- **Named cells**: every file cell carries a status bar item with the name it
  will be written under — auto-generated names are labelled `(auto)` so they are
  never a surprise. Click it (or run **Compiler Notebook: Rename File Cell**) to
  set the name; an empty answer goes back to auto. Buildspec cells show
  `compiler · mode · N file(s)`, with the flags in the tooltip.
- **Diagnostics** are real editor warnings on a `DiagnosticCollection`, keyed on
  cell URIs and refreshed as you type — buildspec problems squiggle the offending
  line. They are repeated in the build output so a run stays self-contained.
- A `// @file x.cpp` directive is persisted into `metadata.filename` when the
  project is run, and a rename keeps the directive line in step.

Next up (phase 5): Rust and Zig, which should be table entries plus a per-language
argument builder — `zig build-exe` does not take `-o`.

## Develop

Needs Node 20+ (`vsce` and the test runner both assume it); `.nvmrc` pins 22.

```sh
nvm use             # honours .nvmrc
npm install
npm run compile     # or: npm run watch
npm test            # resolver + buildspec unit tests, build tests via a stub compiler
```

Press <kbd>F5</kbd> to launch the Extension Development Host, then open an
example and run a cell:

| Example | Shows |
| --- | --- |
| `examples/hello.cnb` | Two independent projects, prose inside a project, `mode = "build"`. |
| `examples/assets.cnb` | Sub-directories in filenames, an asset cell read at runtime. |

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
| `src/notebook.ts` | `NotebookDocument` → resolver bridge, memoised per notebook version. |
| `src/controller.ts` | The kernel: resolve → dedupe → build → stream output. |
| `src/diagnostics.ts` | Soft problems as editor squiggles on a `DiagnosticCollection`. |
| `src/filenames.ts` | Cell status bar items, the rename command, `@file` sync-back. |
