# Settings & Skills

PiDeck provides visual configuration management for all its settings.

## Opening Settings

Click the gear icon in the toolbar to open the settings panel. Settings are organized into tabs:

### Models

Configure the AI models available to your agents:

- **Provider** — Select from supported providers (OpenAI, Anthropic, etc.) or add a custom name.
- **Model** — Choose the specific model version.
- **Endpoint** — Custom API endpoint URL (for proxies or self-hosted models).
- **Connection test** — Verify a provider without leaving the dialog.

Saving writes `models.json` and mirrors it into `models.yml`.

### Auth

Two credential sources, both surfaced in the Auth tab:

**omp-native OAuth** (top section) — talks to omp's `get_login_providers` / `login` / `get_logout_accounts` / `logout`:

1. Requires a running agent; without one the section only shows a hint.
2. Clicking Login makes omp return the authorization URL, which PiDeck opens in the system browser and also shows as a copyable loopback URL, with an input for the pasted code. Switching tabs does not lose the callback.
3. Authenticated providers offer **Manage credentials**, listing stored credentials for individual revocation.
4. omp builds without these RPCs report "no OAuth provider available" instead of failing the dialog.

**API keys** — keys are written to `providers.<name>.apiKey` in `models.yml`; environment variable names and `!command` values are stored verbatim. Clearing a key removes that provider's `apiKey` while keeping the provider entry, its `models` and `baseUrl`. If `models.yml` cannot be parsed, saving is refused so a broken file is never rewritten half-empty.

`auth.json` is no longer read or written. Exported config packages never contain API keys; importing keeps the local keys.

### Model Roles

The Settings **Model Roles** tab visualizes omp's `modelRoles` with 15 roles in two groups:

- Chat roles: `default`, `smol`, `slow`, `vision`, `plan`, `commit`, `tiny`, `memory`, `task`, `advisor`.
- Kind-scoped roles: `image`, `web`, `speech`, `dictation`, `judge`.

The picker only lists models whose kind the role accepts. The same page also edits model presets (`modelPresets`), the model cycle order (`cycleOrder`), and fallback chains (`retry.fallbackChains`) — all written to the global `config.yml` and picked up by running sessions after a restart.

Accepted kinds, selector format, preset rules and troubleshooting live in [Model Configuration](/en/guide/models).

### General Settings

- **Language** — Interface language.
- **Theme** — Light, dark, or system theme.
- **Font Size** — Adjust the editor and terminal font size.
- **Auto-save** — Configure session auto-save intervals.

## Skills

Skills extend the agent's capabilities. PiDeck supports two levels:

### Global Skills

Skills that apply to all projects. Managed in the main settings panel:

- Enable or disable built-in skills
- Configure skill-specific settings
- Install new skills from the skill store

### Project-Level Skills

Skills that apply only to a specific project. Accessible from the project context menu:

- Override global skill settings per project
- Enable project-specific skills
- Configure skill parameters for the project context

## Extensions

Extensions add new functionality to PiDeck itself (not the agent). Manage them in the Extensions tab:

- **Installed Extensions** — View and manage installed extensions.
- **Extension Store** — Browse and install community extensions.
- **Custom Extensions** — Load your own extensions from local files.

## Keyboard Shortcuts

| Action | Shortcut |
|--------|----------|
| Toggle sidebar | `Ctrl+B` |
| Toggle file drawer | `Ctrl+Shift+E` |
| Toggle terminal | `` Ctrl+` `` |
| Open settings | `Ctrl+,` |
| New session | `Ctrl+N` |
| Search files | `Ctrl+P` |
| Command palette | `Ctrl+Shift+P` |
