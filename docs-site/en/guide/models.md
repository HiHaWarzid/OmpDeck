# Model Configuration

Model setup has three layers: omp's model catalog decides which models can be picked, `models.yml` decides what each provider/model/credential looks like, and `config.yml` decides which role uses which model. PiDeck exposes all three; this page documents how they are actually read and written.

## The four files

| File | Location | Role |
|---|---|---|
| `models.yml` | `~/.omp/agent/` | Authoritative provider/model/credential source that omp reads (`providers.<name>.apiKey`) |
| `models.json` | `~/.omp/agent/` | PiDeck's model form data and compatibility mirror |
| `config.yml` | `~/.omp/agent/` | Global settings source; model roles, presets, cycle order, fallback chains |
| `auth.json` | — | Deprecated; PiDeck no longer reads or writes it |

### What each screen reads

| Entry point | Reads | Writes |
|---|---|---|
| Config → Models (provider cards, model grid, connection test) | `models.json`, falling back to `models.yml` (and best-effort migrating a json copy) when missing | `models.json`, then the whole table is mirrored into `models.yml` (mirror failures are warnings) |
| Config → Auth | `models.yml`, falling back to `models.json` when missing | In-place patch of `models.yml`, then a `models.json` mirror is written (failures are warnings) |
| Config export | `models.yml` | — |
| Config import | Package data, merged onto the local `models.yml` | `models.json` and `models.yml` |
| Running sessions | omp reads `models.yml` itself | — |

Two consequences worth knowing:

- **Providers or models you hand-edit into `models.yml` do not show up on the Models page**, which is driven by `models.json`. Keep `models.json` in sync from the raw-file tab, or delete it so PiDeck migrates the yml again.
- **Saving on the Models page rewrites the whole `models.yml`** from `models.json`, dropping comments. To edit only a key while keeping comments, use the Auth tab (it patches the YAML document in place).

## Model catalog

The list of selectable models comes from omp; PiDeck ships no built-in catalog.

1. The first request probes `omp --help` to detect the command shape: newer builds use `models --json`, older ones the table-format `--list-models`.
2. By default only `kind = chat` entries are kept. The Model Roles page also needs image/speech entries, so it appends `--kind all`.
3. Results are cached in process memory (one cache for the picker, one for the roles page) instead of spawning omp again. Catalog refreshes may hit the network and can take a dozen seconds on first use.
4. `kind = embedding` entries never appear anywhere.

Catalog `kind` values: `chat`, `image`, `search`, `tts`, `stt`, `judge`, `tiny` (old omp builds return no `kind`; those entries are treated as chat-capable).

### Why only some models are listed

- **In-session model switching** (status-bar menu) lists `kind = chat` only.
- **Model Roles** filters by the kind each role accepts — see below.

## models.yml structure

```yaml
providers:
  openai:
    baseUrl: https://api.openai.com/v1
    apiKey: OPENAI_API_KEY
    api: openai-completions
    models:
      - id: gpt-5
        name: GPT-5
        reasoning: true
        contextWindow: 400000
        maxTokens: 128000
        input: ["text","image"]
        compat:
          supportsReasoningEffort: true
  local-gateway:
    baseUrl: http://127.0.0.1:8080/v1
    apiKey: "!op read op://dev/gateway-key"
    models:
      - id: qwen3-coder
```

| Field | Meaning |
|---|---|
| `providers.<name>.baseUrl` | Endpoint for that provider |
| `providers.<name>.apiKey` | Credential: a literal key, an environment variable name, or a `!command`. Stored verbatim; PiDeck performs no prefix or type checks |
| `providers.<name>.api` | API shape. Aliases are normalized: `anthropic`/`anthropic-messages` → `anthropic-messages`, `openai-chat-completions` → `openai-completions`, missing or unknown → `openai-completions`; other known values are kept (`openai-responses`, `openai-codex-responses`, `google-generative-ai`, `mistral-conversations`) |
| `providers.<name>.models[]` | Model array; `id` is required. `name`, `reasoning`, `contextWindow`, `maxTokens`, `input`, `compat`, `thinking`, `thinkingLevelMap` are interpreted by omp |
| Anything else | Mirrored back verbatim — no allow-list filtering |

Save-time rules:

- **Auth tab** changes only `providers.<name>.apiKey` (in-place patch, comments and hand-written fields survive). A provider that is missing from the submitted data, or has an empty key, has its key removed while the provider entry, its `models` and `baseUrl` stay. A `models.json` mirror is written afterwards.
- **A `models.yml` that fails to parse is never saved**; PiDeck asks you to repair it first. Empty declarations such as `providers: null` or `openai:` are normalized to empty mappings instead of erroring.
- **Models page / raw-file save** treats `models.json` as the source and mirrors the whole table into `models.yml` (fixed field order, comments lost). A failed mirror is reported as a warning rather than silently diverging.

## Model roles

`modelRoles.<role>` in `config.yml` selects the model for each use case. Selectors use:

```text
provider/modelId[:thinkingLevel]
```

For example `anthropic/claude-sonnet-4-5:high`. Omitting `:thinkingLevel` keeps the default thinking level.

15 roles exist, and the picker filters by the kinds each accepts:

| Group | Roles | Accepted kinds |
|---|---|---|
| Chat | `default`, `smol`, `slow`, `vision`, `plan`, `commit`, `task`, `advisor` | `chat` |
| Chat | `tiny`, `memory` | `tiny`, `chat` |
| Kind-scoped | `image` | `image` |
| Kind-scoped | `web` | `search`, `chat` |
| Kind-scoped | `speech` | `tts` |
| Kind-scoped | `dictation` | `stt` |
| Kind-scoped | `judge` | `judge`, `tiny`, `chat` |

`vision` takes a text model — it describes images, so its candidates are `chat` models, not `kind = image` generators.

Roles are written to the global `config.yml`; running sessions pick them up after a restart.

## Model presets

A preset snapshots every role plus the default thinking level under `modelPresets.<name>` in `config.yml`:

```yaml
modelPresets:
  fast-coding:
    modelRoles:
      default: anthropic/claude-sonnet-4-5
      smol: anthropic/claude-haiku-4-5
    defaultThinkingLevel: medium
```

- Names must start with a letter and may contain letters, digits, `_` and `-`.
- Applying a preset **replaces `modelRoles` wholesale** (roles absent from the preset are cleared).
- A preset without `defaultThinkingLevel` keeps the current top-level level.
- Structurally invalid presets are not listed for apply/delete, but stay in the file for the raw-file tab to repair.

## Cycle order and fallback chains

- `cycleOrder`: comma-separated role list controlling the order visited when cycling models; clearing it deletes the key and restores omp's default order.
- `retry.fallbackChains`: maps a role or model selector to ordered fallback selectors; removing the last chain also removes the empty `retry` key.

Both live in the global `config.yml` and, like presets, need a session restart to take effect.

## Import and export

- Exports contain **no `apiKey` at all** (literal keys, env var names and `!command` values are all omitted) and include `modelRoles`, `modelPresets`, `cycleOrder`, `retry.fallbackChains` plus the settings-tab keys.
- Imports merge onto the local `models.yml`: missing or empty keys in the package keep the machine's existing values; only an explicitly non-empty key overrides.
- Import aborts when `models.yml` has parse diagnostics, so repairable content is not discarded before being overwritten.
- `auth.json` inside old packages is ignored.

## Troubleshooting

**Empty model list**

1. Run `omp --help` and confirm a `models` (or `--list-models`) command exists.
2. The first catalog fetch may hit the network — wait, or check the proxy settings.
3. Open Settings → Storage & Logs and look for `pi model list returned no parsable entries`.

**Still 401 after saving**

- Verify `apiKey` actually landed in `models.yml` for that provider (that is the file the Auth tab writes).
- After importing a config, confirm the local key survived (exports carry no keys).
- omp resolves credentials from `models.yml`; `auth.json` plays no part.

**Auth tab says no running agent**

OAuth provider lists and credentials come from the omp runtime: start a session first, then revisit the Auth tab (it re-probes when the dialog regains focus).

**Auth tab says this omp build has no OAuth provider**

Older omp builds lack `get_login_providers` and friends; the API-key form below still works.

**Saving reports a `models.yml` parse failure**

The file itself is broken. `models.yml` is not exposed in the raw-file tab (which only offers `config.yml`, `models.json`, `trust.json`), so open `~/.omp/agent/models.yml` in an external editor. PiDeck will not rewrite an unparsable file into a half-empty one.
