# Compiler Notebook

A VS Code extension that gives compiled languages a Jupyter-like notebook
experience: Markdown prose interleaved with source-file cells that compile and
run in one click, in a fresh isolated temp dir. Not a REPL — no state carries
between runs.

See [CLAUDE.md](CLAUDE.md) for the full design.

## Status — phase 5

- `.cnb` JSON notebook format (`NotebookSerializer`), metadata round-trips. Cell
  text is stored **one line per array entry**, so `git diff` shows the line you
  edited rather than the whole cell, and two people editing different parts of a
  cell no longer conflict. Files written with the old single-string form still
  open, and convert on the next save.
- **C, C++, Rust and Zig.** A project's language comes from its cells, and with
  it the compiler, the default flags and the shape of the command line — all
  from one table in `src/languages.ts`. C and C++ hand every translation unit to
  the compiler; Rust and Zig are pointed at a single **root** file (the cell with
  the entry point) and reach the rest through `mod` / `@import`. Zig has no `-o`,
  so it gets `zig build-exe main.zig --name app`.
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
- Compiler diagnostics and program output stream into the cell as they arrive,
  with `stderr` rendered as `stderr`. Floods are capped at 2000 lines / 512 KB,
  keeping the **head** — the first error is the one that caused the rest — and
  the command lines and exit code are never cut.
- Cancellation kills the child process; temp dirs are always cleaned up.
- **New project**: an empty code cell offers `$(rocket) New project` in its
  status bar — pick a language and the cell becomes a buildspec cell filled in
  with that language's defaults, followed by an empty source cell in that
  language, with the cursor in it. Without it, turning a cell into a project
  means knowing that the language picker in the corner is what does it. Also on
  the command palette as **Compiler Notebook: New Project**.
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

All six phases of the plan in [CLAUDE.md](CLAUDE.md) §8 are in, except the
optional rich output renderer.

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
| `examples/rust.cnb` | A Rust crate across two cells, joined by `mod`. |
| `examples/zig.cnb` | A Zig program across two cells, joined by `@import`. |

Zig cells need the Zig extension installed for `zig` to exist as a language id
(and for highlighting); `rust`, `c` and `cpp` are built into VS Code.

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
| `src/output.ts` | Output limiting. No `vscode` import. |
| `src/cnb.ts` | The `.cnb` file format itself. No `vscode` import, round-trip tested. |
| `src/serializer.ts` | `.cnb` ⇄ `NotebookData`. |
| `src/notebook.ts` | `NotebookDocument` → resolver bridge, memoised per notebook version. |
| `src/controller.ts` | The kernel: resolve → dedupe → build → stream output. |
| `src/diagnostics.ts` | Soft problems as editor squiggles on a `DiagnosticCollection`. |
| `src/filenames.ts` | Cell status bar items, the rename command, `@file` sync-back. |
| `src/newproject.ts` | The "New project" affordance on an empty cell. |
