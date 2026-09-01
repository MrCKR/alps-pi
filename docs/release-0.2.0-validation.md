# alps-pi 0.2.0 Validation

## Baseline

- Pi coding-agent: `0.84.4`
- Pi TUI: `0.84.4`
- Windows Terminal: `1.24.11911.0`
- Package version: `0.2.0`

## Automated Checks

- `npm test`: 302 passed, 0 failed
- `npm run typecheck`: passed with strict NodeNext settings
- `git diff --check`: passed; Git only reports the existing Windows LF/CRLF normalization notice
- `npm pack --dry-run`: `alps-pi-0.2.0.tgz`, 36 release files, no test files

## Runtime Integration

- Real `TuiAltScreen` retained Pi native fullscreen dock, transcript scrolling, overlay handling, selection API, and terminal ownership after Alps editor/footer installation.
- Stable TUI proxy regular/fullscreen/regular transition retained one editor, one footer, one input listener, and unchanged renderer/terminal descriptors while streaming.
- Real Pi `AgentSession` lifecycle covered `reload`, `newSession`, and `switchSession`; every replacement left exactly one Alps editor/footer/input listener.
- Real no-UI child `AgentSession` start/shutdown did not alter the parent Chrome Frame patch or preference.
- Real `AssistantMessageComponent` received `updateContent(message, true)` and `updateContent(message, false)` through the Alps wrapper; Markdown transformer state observed both values.
- Real `ToolExecutionComponent` preserved Kitty and iTerm image escape payloads exactly once without an Alps frame.
- Settings stress test used 3 rounds of 5 independent Node processes; all independently changed fields survived, JSON remained parseable, and no lock/temp files remained.

## Windows Terminal Gate

Executed in Windows Terminal `1.24.11911.0` using Pi `0.84.4` and `tuiMode: fullscreen`:

- Alps startup rendered the native fullscreen transcript/editor dock.
- `/alps-pi` opened a settings overlay without disrupting the native dock.
- 80-line output was scrolled with the native terminal viewport.
- Drag selection copied `line-64` to the clipboard.
- Double-click selection copied `line-70` to the clipboard.
- Right-click paste inserted `gatepaste` into the editor.
- Regular/fullscreen switching via Pi `/settings` preserved the session and terminal state.
- Ctrl+C exited Pi back to the PowerShell prompt; the Windows Terminal window was then closed normally.
- Clipboard failure, overlay, scrolling, and stop behavior are covered by the real `TuiAltScreen` integration tests.

## Package Resolution

The generated tarball was installed into an isolated npm project alongside host Pi/TUI `0.84.4`:

- `npm ls` showed Pi/TUI `0.84.4` with both Alps peers deduped.
- `PI_COMPONENTS.AssistantMessageComponent === HostAssistant` was `true`.
- No nested Pi or pi-tui package existed below `alps-pi`.
- The tarball was also unpacked, production dependencies installed, and the resulting package root loaded by Pi's package manager without extension-load warnings; its `index.ts` extension and `themes/alps.json` theme were present.

## Known Installer Detail

Pi's local-path installer treats a raw `.tgz` path as a resource path rather than extracting/installing it. Published npm specs use Pi's npm package installer and install runtime dependencies normally. The isolated gate therefore validates the tarball with npm installation and validates Pi discovery with the production-installed, extracted tarball package root.
