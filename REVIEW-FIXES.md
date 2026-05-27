# Alps Pi review fixes

This temp implementation has been updated for the review blockers/fixes in `alps-pi-subagents/reviews`.

## Runtime safety notes

- `/alps-pi preview` now calls the real Pi `ctx.ui.custom(factory, options)` contract and awaits/catches the returned promise.
- Preview is shown as an overlay and closes through `Esc`, `q`, `Q`, `Enter`, or `Ctrl+C` by calling the injected `done` callback.
- `Loader.prototype.render` is no longer a runtime patch target. Working chrome is retained only as pure rendering/preview coverage for now; runtime patch targets are message/tool/bash components only.
- Image escape lines are left unboxed/unbackgrounded/untruncated. Tool component wrapping still uses whole-render fallback when image escapes are detected.
- OSC133 handling matches Pi user/assistant renderers: `START` is extracted from the first line prefix and `END+FINAL` from the final line prefix, then restored to the new box first/final line prefixes.

## Validation

Run from this directory:

```powershell
npm test
```

or from bash/MSYS when `npm` is not on `PATH`:

```bash
C:/Users/Administrator/AppData/Local/nvm/v22.22.3/npm.cmd test
```

The test glob is `test/**/*.test.ts`.
