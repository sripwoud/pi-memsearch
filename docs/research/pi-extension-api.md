# pi extension/package API — primary-source research

Researched 2026-08-13 against pi v0.84.1 (= npm `latest` on this date, verified via `npm view`).

Primary source: the pi-coding-agent package on this machine, cached by the `pi` launcher
(`/home/sripwoud/.local/bin/pi` runs `npx --yes --prefer-online @earendil-works/pi-coding-agent`).
All local citations below are relative to that package root, abbreviated `$PI`:

```
$PI = /home/sripwoud/.npm/_npx/99fca8174466655b/node_modules/@earendil-works/pi-coding-agent
```

`$PI/dist/core/extensions/types.d.ts` is the API authority; `$PI/docs/*.md` are the shipped
first-party docs (mirrored at https://github.com/earendil-works/pi; note https://pi.dev/docs/extensions
returns 404 — pi.dev links to the GitHub repo for topic docs).

## Summary

pi-memsearch's planned shape is fully buildable on pi's API, with these exact mechanisms:

- **Capture + index extension**: a TS module exporting `default function (pi: ExtensionAPI)`, loaded via jiti (no compilation). Hooks: `session_start`/`session_shutdown` (per session), `turn_end`/`agent_end`/`agent_settled` (per run) for capture; `pi.exec()` for shelling out to `uvx`.
- **`/recall`**: two native mechanisms give a literal `/recall` — a **prompt template** `prompts/recall.md` (filename becomes the slash command) or `pi.registerCommand("recall", ...)` in the extension. A **skill** `skills/recall/SKILL.md` is additionally invokable as `/skill:recall` and is agent-discoverable via system-prompt descriptions. All three ship in one package via the `"pi"` field in package.json.
- **Per-turn dynamic context**: the README's "dynamic-context hook" exists as two distinct hooks. `before_agent_start` fires once per user prompt (not once per session) and can inject a persistent `CustomMessage` and/or replace the system prompt. `context` fires before _every LLM call_ (each turn of the agent loop) and can rewrite the outgoing message array non-destructively (ephemeral, not persisted).
- **Transcripts are anchorable**: pi persists JSONL sessions at `~/.pi/agent/sessions/--<cwd-dashed>--/<timestamp>_<uuid>.jsonl` with a stable session UUID in the header and stable 8-char-hex entry IDs on every message — enough to build memsearch-style anchors `<!-- session:ID turn:ENTRY_ID transcript:/abs/path -->`. The schema differs from Claude Code/Codex JSONL, so memsearch's `transcript` command would need a pi parser (simple: one JSON object per line, `type` discriminator).

## 1. Hook surface

Complete `pi.on(...)` inventory from `$PI/dist/core/extensions/types.d.ts:866-899` (event payload
interfaces at the cited lines; return types from the `*Result` interfaces at lines 774-834).
Firing cadence from the lifecycle diagram in `$PI/docs/extensions.md:277-348`.

| Event                                              | Fires                                                                                                                 | Payload (types.d.ts)                                                                        | Handler return                                                                                    |
| -------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `project_trust`                                    | Startup / session-replacement into unresolved cwd; user/global + `-e` extensions only                                 | `{cwd}` (L386-389)                                                                          | `{trusted: "yes"\|"no"\|"undecided", remember?}` (L390-394)                                       |
| `resources_discover`                               | After each `session_start` (startup and reload)                                                                       | `{cwd, reason: "startup"\|"reload"}` (L402-407)                                             | `{skillPaths?, promptPaths?, themePaths?}` (L409-413)                                             |
| `session_start`                                    | Once per session begin: `reason: "startup"\|"reload"\|"new"\|"resume"\|"fork"`, plus `previousSessionFile?`           | L415-421                                                                                    | void                                                                                              |
| `session_info_changed`                             | Session name set/cleared                                                                                              | `{name}` (L423-427)                                                                         | void                                                                                              |
| `session_before_switch`                            | Before `/new`/`/resume`                                                                                               | `{reason, targetSessionFile?}` (L429-433)                                                   | `{cancel?}` (L810-812)                                                                            |
| `session_before_fork`                              | Before `/fork`/`/clone`                                                                                               | `{entryId, position}` (L435-439)                                                            | `{cancel?, skipConversationRestore?}` (L813-816)                                                  |
| `session_before_compact`                           | Before manual/threshold/overflow compaction                                                                           | `{preparation, branchEntries, customInstructions?, reason, willRetry, signal}` (L441-451)   | `{cancel?, compaction?: CompactionResult}` (L817-820) — full takeover possible                    |
| `session_compact`                                  | After compaction                                                                                                      | `{compactionEntry, fromExtension, reason, willRetry}` (L453-461)                            | void                                                                                              |
| `session_shutdown`                                 | Quit (Ctrl+C/D, SIGHUP/SIGTERM), reload, or session replacement (`reason: "quit"\|"reload"\|"new"\|"resume"\|"fork"`) | L463-468                                                                                    | void                                                                                              |
| `session_before_tree` / `session_tree`             | Around `/tree` navigation                                                                                             | L484-496                                                                                    | `{cancel?, summary?, ...}` (L821-834) / void                                                      |
| `input`                                            | Every user input, after extension commands, **before** skill/template expansion                                       | `{text, images?, source: "interactive"\|"rpc"\|"extension", streamingBehavior?}` (L627-637) | `{action:"continue"}` \| `{action:"transform", text, images?}` \| `{action:"handled"}` (L639-647) |
| `before_agent_start`                               | **Once per user prompt**, after expansion, before agent loop                                                          | `{prompt, images?, systemPrompt, systemPromptOptions}` (L524-534)                           | `{message?: CustomMessage-pick, systemPrompt?}` (L805-809) — chained across extensions            |
| `agent_start` / `agent_end`                        | Per low-level agent run (agent_end may be followed by auto-retry/compaction/follow-ups)                               | L536-543                                                                                    | void                                                                                              |
| `agent_settled`                                    | After a run fully settles (no retry/compaction/queued continuation left)                                              | L545-547                                                                                    | void                                                                                              |
| `turn_start` / `turn_end`                          | **Each turn** (one LLM response + its tool calls)                                                                     | `{turnIndex, timestamp}` / `{turnIndex, message, toolResults}` (L549-560)                   | void                                                                                              |
| `context`                                          | **Before each LLM call** within the loop                                                                              | `{messages: AgentMessage[]}` — deep copy, safe to modify (L499-502; docs L648-658)          | `{messages?}` (L774-776)                                                                          |
| `before_provider_headers`                          | After headers assembled, once per provider request (retries reuse)                                                    | `{headers}` mutate in place (L513-516)                                                      | ignored                                                                                           |
| `before_provider_request`                          | After provider payload built, before send                                                                             | `{payload}` (L504-507)                                                                      | replacement payload or undefined (L777)                                                           |
| `after_provider_response`                          | HTTP response received, before stream consumed                                                                        | `{status, headers}` (L518-522)                                                              | void                                                                                              |
| `message_start` / `message_update` / `message_end` | Per message (user/assistant/toolResult); update = streaming tokens                                                    | L562-576                                                                                    | `message_end`: `{message?}` replacement, same role (L801-804)                                     |
| `tool_execution_start/update/end`                  | Tool execution lifecycle (observability)                                                                              | `{toolCallId, toolName, args/partialResult/result, isError}` (L578-599)                     | void                                                                                              |
| `tool_call`                                        | Before a tool executes; **can block**; `event.input` mutable in place                                                 | discriminated union per built-in tool + `CustomToolCallEvent` (L648-690)                    | `{block?, reason?, terminate?}` (L778-787)                                                        |
| `tool_result`                                      | After a tool executes; **can modify result**                                                                          | `{toolCallId, toolName, input, content, isError, details, usage?}` (L691-733)               | `{content?, details?, isError?, usage?}` (L795-800)                                               |
| `user_bash`                                        | User `!`/`!!` commands; can intercept/replace execution                                                               | `{command, excludeFromContext, cwd}` (L615-623)                                             | `{operations?, result?}` (L789-794)                                                               |
| `model_select` / `thinking_level_select`           | Model or thinking-level change                                                                                        | L600-613                                                                                    | void                                                                                              |

### The "dynamic-context hook": what actually exists

The pi-memsearch README's "dynamic-context hook" (README.md:21) maps to two real hooks with
different semantics — pick per use case:

|                                | `before_agent_start`                                                                                                      | `context`                                                                                |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| Cadence                        | Once per **user prompt** (docs/extensions.md:521-523)                                                                     | Before **every LLM call**, i.e. every turn of the tool loop (docs/extensions.md:648-650) |
| Sees                           | `prompt` text, current chained `systemPrompt`, `systemPromptOptions` (incl. loaded skills/context files)                  | Full outgoing `AgentMessage[]` (deep copy)                                               |
| Can do                         | Inject a **persistent** custom message (stored in session, sent to LLM) and/or replace the system prompt for this turn    | Return filtered/augmented `messages` — **ephemeral**, never persisted                    |
| Fit for memsearch auto-context | Yes — query memsearch with `event.prompt`, return `{message: {customType: "memsearch", content: chunks, display: false}}` | Only for pruning/rewriting; injected content would need re-adding on every call          |

Shipped examples using this pattern: `pirate.ts` ("Modify system prompt per-turn"),
`claude-rules.ts` ("Load rules from files", `session_start` + `before_agent_start`),
`prompt-customizer.ts` (`systemPromptOptions`) — `$PI/docs/extensions.md:2920,2938,2939`,
sources in `$PI/examples/extensions/`.

Out-of-band injection is also possible any time via `pi.sendMessage({customType, content, display},
{triggerTurn?, deliverAs: "steer"|"followUp"|"nextTurn"})` (types.d.ts:924-927; docs/extensions.md:1389-1410).

Caveat: `before_agent_start` fires only after real user prompts. Messages injected by other
extensions via `sendMessage` don't pass through it; `input` (source `"extension"`) fires for
`sendUserMessage` (types.d.ts:625).

## 2. Package anatomy

Authority: `$PI/docs/packages.md`.

The `"pi"` field in package.json declares four resource types (packages.md:120-133):

```json
{
  "name": "pi-memsearch",
  "keywords": ["pi-package"],
  "pi": {
    "extensions": ["./extensions"],
    "skills": ["./skills"],
    "prompts": ["./prompts"],
    "themes": ["./themes"]
  }
}
```

Paths are package-root-relative; arrays support globs and `!exclusions` (packages.md:133).
Optional `video`/`image` fields feed the https://pi.dev/packages gallery (packages.md:137-154).
Without a `pi` manifest, convention directories auto-discover: `extensions/` (`.ts`/`.js`),
`skills/` (recursive `SKILL.md` folders + top-level `.md`), `prompts/` (`.md`, **non-recursive**),
`themes/` (`.json`) (packages.md:160-165; prompt-templates.md:95-97).

### Skills (`$PI/docs/skills.md`)

- Format: directory with `SKILL.md` — YAML frontmatter (`name` + `description` required; optional
  `license`, `compatibility`, `metadata`, `allowed-tools`, `disable-model-invocation`) + markdown
  body (skills.md:107-149). Implements the Agent Skills standard (agentskills.io), leniently
  (skills.md:7). Missing description = skill not loaded (skills.md:186).
- Discovery: `~/.pi/agent/skills/`, `~/.agents/skills/`, project `.pi/skills/` and `.agents/skills/`
  (after trust), packages, `skills` settings array, `--skill <path>` (skills.md:24-34).
- Invocation: two paths. (1) Progressive disclosure — name+description go into the system prompt;
  the agent `read`s the full SKILL.md when a task matches (skills.md:64-71). (2) User-explicit —
  every skill registers a `/skill:name` command; args are appended as `User: <args>`
  (skills.md:75-82). Skill commands are on by default (`enableSkillCommands ?? true` —
  `$PI/dist/core/settings-manager.js:745`; docs/settings.md:246).
- `disable-model-invocation: true` hides a skill from the system prompt, making it `/skill:name`-only
  (skills.md:149).

### Prompt templates (`$PI/docs/prompt-templates.md`)

- Markdown files with optional frontmatter (`description`, `argument-hint`); **filename = command**:
  `recall.md` → `/recall` (prompt-templates.md:5,31-33).
- Argument substitution: `$1..$n`, `$@`/`$ARGUMENTS`, `${1:-default}`, `${@:N}`, `${@:N:L}`
  (prompt-templates.md:67-75).
- So `/recall <query>` as planned = `prompts/recall.md` containing the recall workflow prompt with
  `$@` for the query. Expansion happens after the `input` event, before `before_agent_start`
  (docs/extensions.md:888-893).

### /recall naming collision note

If both a prompt template `recall.md` and an extension `registerCommand("recall")` exist,
extension commands are checked first in input processing (docs/extensions.md:889). Duplicate
extension commands get suffixes `/recall:1` (docs/extensions.md:1498). `pi.getCommands()` lists
all three sources with provenance (`source: "extension"|"prompt"|"skill"`, docs/extensions.md:1529-1557).

## 3. Tool and command registration

### pi.registerTool (types.d.ts:901, ToolDefinition L343-376)

```ts
pi.registerTool({
  name: string, label: string, description: string,
  promptSnippet?: string,          // one-liner in system prompt "Available tools"
  promptGuidelines?: string[],     // bullets appended to Guidelines while active
  parameters: TSchema,             // TypeBox schema
  executionMode?: "sequential" | "parallel",
  prepareArguments?: (args: unknown) => Static<TParams>,
  execute(toolCallId: string, params: Static<TParams>, signal: AbortSignal | undefined,
          onUpdate: AgentToolUpdateCallback<TDetails> | undefined, ctx: ExtensionContext
         ): Promise<AgentToolResult<TDetails>>,
  renderCall?, renderResult?,      // custom TUI rendering
})
```

`AgentToolResult<T>` = `{ content: (TextContent|ImageContent)[], details: T, usage?, addedToolNames? }`
(`$PI/node_modules/@earendil-works/pi-agent-core/dist/types.d.ts:316-324`). Errors are signaled by
throwing; pi reports them to the LLM with `isError: true` (docs/extensions.md:2891). Works during
load and at runtime (inside `session_start`, commands) without `/reload` (docs/extensions.md:1342).
`defineTool()` helper preserves inference (types.d.ts:385).

### Other registration APIs (types.d.ts:901-1028)

| API                                                                                                           | Purpose                                                            |
| ------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `registerCommand(name, {description?, getArgumentCompletions?, handler(args, ctx: ExtensionCommandContext)})` | Slash command (L903, L851-857)                                     |
| `registerShortcut(keyId, {handler})`                                                                          | Keyboard shortcut (L905-908)                                       |
| `registerFlag(name, {type, default?})` / `getFlag`                                                            | CLI flags (L910-916)                                               |
| `registerMessageRenderer` / `registerEntryRenderer` / `registerMarkdownTransformer`                           | TUI rendering (L918-922)                                           |
| `sendMessage` / `sendUserMessage` / `appendEntry`                                                             | Inject context / user msg / persist non-context state (L924-936)   |
| `setSessionName` / `getSessionName` / `setLabel`                                                              | Session metadata (L938-942)                                        |
| `exec(command, args, options?)`                                                                               | Spawn processes (L944) — the mechanism for `uvx ... memsearch ...` |
| `getActiveTools` / `getAllTools` / `setActiveTools` / `getCommands`                                           | Tool/command introspection (L946-952)                              |
| `setModel` / `get/setThinkingLevel`                                                                           | Model control (L954-958)                                           |
| `registerProvider` / `unregisterProvider`                                                                     | Custom LLM providers (L1011-1026)                                  |
| `events: EventBus`                                                                                            | Inter-extension pub/sub (L1028)                                    |

There is **no `registerSkill` or `registerPrompt`** on ExtensionAPI. Extensions contribute skills
and prompt templates dynamically only via the `resources_discover` hook returning
`skillPaths`/`promptPaths` (types.d.ts:402-413); statically via the package manifest.

## 4. Session persistence

Authority: `$PI/docs/session-format.md` and `$PI/docs/sessions.md`.

- **Where**: auto-saved to `~/.pi/agent/sessions/--<path>--/<timestamp>_<uuid>.jsonl` where `<path>`
  is the cwd with `/` → `-` (session-format.md:7-9). `--no-session` disables persistence
  (sessions.md:12). (On this machine `~/.pi/agent/sessions/` doesn't exist yet — pi has not
  persisted a session — so the pattern is doc-verified, not disk-verified.)
- **Format**: JSONL, one JSON object per line, `type` discriminator; version 3 current, older
  versions auto-migrated on load (session-format.md:3,21-27).
- **Stable IDs**:
  - Session UUID in the header line: `{"type":"session","version":3,"id":"uuid","timestamp":...,"cwd":...}` (session-format.md:194).
  - Every entry has `id` (8-char hex) + `parentId`, forming a tree (session-format.md:179-185).
  - At runtime: `ctx.sessionManager.getSessionId()`, `.getSessionFile()`, `.getLeafId()`, `.getEntry(id)` (session-format.md:437-438,417-419; dist/core/session-manager.d.ts:207-208,239).
- **Entry types**: `session` (header), `message` (wraps `AgentMessage`: user/assistant/toolResult/
  bashExecution/custom/branchSummary/compactionSummary), `model_change`, `thinking_level_change`,
  `compaction` (with `retainedTail` checkpoint), `branch_summary`, `custom` (extension state, NOT
  in LLM context), `custom_message` (extension message, IS in LLM context), `label`, `session_info`
  (session-format.md:39-304).

### Anchorability for memsearch

memsearch anchors embed `<!-- session:ID turn:UUID transcript:/abs/path -->`. Mapping:

| memsearch anchor field | pi equivalent                           | Stability                                                                                                                             |
| ---------------------- | --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `session:ID`           | header `id` (UUID) — `getSessionId()`   | Stable for the file's lifetime; `/fork`/`/clone` create a new file+UUID with `parentSession` back-pointer (session-format.md:197-201) |
| `turn:UUID`            | entry `id` (8-char hex, **not** a UUID) | Stable; entries are append-only; branching adds children, never rewrites (session-format.md:306-312)                                  |
| `transcript:/abs/path` | `getSessionFile()`                      | Stable path; deletable by the user via `/resume` Ctrl+D (session-format.md:13-17)                                                     |

Caveats: (1) entry IDs are 8-char hex, so the anchor grammar must accept short IDs; (2) the active
branch is a tree walk (leaf → root via `parentId`), not the raw line order — a parser wanting "the
conversation as the LLM saw it" must replicate `buildContextEntries()` semantics
(session-format.md:326-342); (3) pi's schema shares nothing with Claude Code/Codex JSONL, so
memsearch's `transcript` command needs a dedicated pi adapter. The doc ships a reference parser
(session-format.md:344-384) and `SessionManager.open(path)` is importable from
`@earendil-works/pi-coding-agent` for in-process parsing (session-format.md:391-395).

## 5. ExtensionContext

`$PI/dist/core/extensions/types.d.ts:209-249`:

| Member                                                          | Type/notes                                                                                                                                                                                                                                                   |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `ui`                                                            | `ExtensionUIContext` — select/confirm/input/notify, setStatus, setWidget, setFooter/Header, custom components, editor access, themes (L68-192)                                                                                                               |
| `mode` / `hasUI`                                                | `"tui"                                                                                                                                                                                                                                                       |
| `cwd`                                                           | current working directory (L217)                                                                                                                                                                                                                             |
| `sessionManager`                                                | `ReadonlySessionManager` = Pick of getCwd, getSessionDir, getSessionId, getSessionFile, getLeafId, getLeafEntry, getEntry, getLabel, **getBranch**, buildContextEntries, getHeader, getEntries, getTree, getSessionName (dist/core/session-manager.d.ts:140) |
| `modelRegistry`                                                 | `ModelRegistry`: `getAvailable()`, `find(provider, modelId)`, `getApiKeyAndHeaders(model)`, `getProviderAuth(provider)`, `getApiKeyForProvider(provider)`, `getProviderAuthStatus` (dist/core/model-registry.d.ts:20-36)                                     |
| `model` / `thinkingLevel` / `scopedModels`                      | active model (may be undefined), effective thinking level, session-scoped model list (L222-230)                                                                                                                                                              |
| `isIdle()` / `signal` / `abort()` / `hasPendingMessages()`      | streaming state; `signal` defined during active turn events, undefined when idle (L231-240; docs/extensions.md:992-1002)                                                                                                                                     |
| `isProjectTrusted()`                                            | project trust incl. temporary decisions (L233-234)                                                                                                                                                                                                           |
| `shutdown()`                                                    | graceful exit, emits `session_shutdown`; deferred until idle in tui/rpc (L241-242; docs/extensions.md:1021-1029)                                                                                                                                             |
| `getContextUsage()` / `compact(options?)` / `getSystemPrompt()` | context budget, fire-and-forget compaction, current system prompt string (L243-248)                                                                                                                                                                          |

`ExtensionCommandContext` (command handlers only, L254-291) adds: `getSystemPromptOptions()`,
`waitForIdle()`, `newSession()`, `fork()`, `navigateTree()`, `switchSession()`, `reload()`.
These are command-only because they can deadlock in event handlers (docs/extensions.md:1082-1084).

### Version variance (answers pi-memory's feature-detection questions)

pi-memory (pinned 0.84.1) feature-detects `ctx.sessionManager.getBranch` and
`ctx.modelRegistry.getApiKey`/`find`. In 0.84.1:

- `getBranch(fromId?)` **is** in the `ReadonlySessionManager` Pick (session-manager.d.ts:140,261) — no cast needed at this version.
- `find(provider, modelId)` exists (model-registry.d.ts:28).
- A bare `getApiKey` does **not** exist; the current names are `getApiKeyForProvider(provider)` (L36), `getApiKeyAndHeaders(model)` (L30), and `getProviderAuth(provider)` (L35). Code feature-detecting `getApiKey` is targeting an older/newer API shape — pin `@earendil-works/pi-coding-agent` >= 0.84 and use `getApiKeyForProvider`.

## 6. Extension loading

- **Runtime**: extensions are loaded via jiti — TypeScript runs without compilation
  (docs/extensions.md:179; `jiti: "2.7.0"` in `$PI/package.json` dependencies). Entry: default-export
  factory `(pi: ExtensionAPI) => void | Promise<void>`; async factories are awaited before
  `session_start` and `resources_discover` (docs/extensions.md:156-181; types.d.ts:1104).
- **Discovery**: `~/.pi/agent/extensions/*.ts` and `*/index.ts` (global), `.pi/extensions/...`
  (project, after trust), `packages`/`extensions` arrays in settings.json (docs/extensions.md:109-135).
- **`pi -e ./file.ts` vs `pi install`**: `-e`/`--extension` loads a file or package for the current
  run only (packages install to a temp dir); `pi install npm:...`/`git:...`/path writes to
  `~/.pi/agent/settings.json` (or `.pi/settings.json` with `-l`) and installs under `~/.pi/agent/npm/`
  or `.pi/npm/` (packages.md:22-50,63-66). Versioned npm specs are pinned and skipped by
  `pi update --extensions` (packages.md:63).
- **peerDependencies**: pi bundles its core packages; if imported, list `@earendil-works/pi-ai`,
  `@earendil-works/pi-agent-core`, `@earendil-works/pi-coding-agent`, `@earendil-works/pi-tui`,
  `typebox` in `peerDependencies` with `"*"` and do not bundle (packages.md:171). Runtime deps go in
  `dependencies`; installs run `npm install --omit=dev`, so nothing needed at runtime may live in
  `devDependencies` (docs/extensions.md:150). Other pi packages must be bundled via
  `bundledDependencies` (packages.md:173-188).
- **Long-lived resources**: don't start watchers/processes in the factory (it runs in invocations
  that never start a session); defer to `session_start`, clean up in an idempotent
  `session_shutdown` (docs/extensions.md:220-224). Relevant to memsearch's "never run `watch`
  alongside ad-hoc calls" constraint.
- **State across restarts**: reconstruct from the session — tool-result `details` or `custom`
  entries — on `session_start` (docs/extensions.md:1846-1878; pattern for capture dedup/watermarks).

## 7. Direct answers to pi-memory.md open questions

| Open question (pi-memory.md:195-201)                                 | Answer                                                                                                                                                                                                                                                                                                                   |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Exact hook signatures/payloads                                       | Verified above from `$PI/dist/core/extensions/types.d.ts`; `{systemPrompt}` return and 5-arg `execute` confirmed (L805-809, L371)                                                                                                                                                                                        |
| `getBranch` / `getApiKey` variance                                   | `getBranch` official at 0.84.1; bare `getApiKey` does not exist at 0.84.1 — see section 5                                                                                                                                                                                                                                |
| Does pi support skills / prompt-template registration for `/recall`? | Yes — packages declare `skills`/`prompts` in the `pi` manifest; prompt template `recall.md` yields a literal `/recall`; skills yield `/skill:recall` + agent auto-discovery (section 2)                                                                                                                                  |
| `before_agent_start` for sub-agents?                                 | pi core has no in-process sub-agents; the shipped `subagent/` example spawns separate `pi --mode json -p --no-session` processes (`$PI/examples/extensions/subagent/index.ts:294,335`), each with its own extension runtime — the parent's hooks never see child events, and `--no-session` children write no transcript |
| Compaction mid-tool-call handoff                                     | Still not documented; see Open questions                                                                                                                                                                                                                                                                                 |

## Open questions

- `session_before_compact` behavior when compaction triggers mid-tool-call (overflow during a tool
  batch): `willRetry`/`reason:"overflow"` describe retry semantics (types.d.ts:446-450) but neither
  docs nor types state whether in-flight tool calls complete first. Needs an empirical test or a
  read of `dist/core/compaction/` internals.
- Session file path pattern is doc-verified only; `~/.pi/agent/sessions/` does not exist on this
  machine yet. Verify the `--<path>--` dashing (e.g. leading/trailing `--`, non-ASCII cwd) once a
  session is persisted.
- Whether `before_agent_start`/`context` fire identically in `--mode json` / `-p` print mode is
  implied by "extensions run but can't prompt" (docs/extensions.md:2900) but not explicitly per-hook
  documented.
- The launcher runs `npx --prefer-online ... @latest`, so the local pi silently tracks new releases;
  today latest = 0.84.1, but pi-memsearch should pin its peer-dep floor at `>=0.84.1` and re-verify
  `ModelRegistry`/`ReadonlySessionManager` names on major bumps (API marked stable nowhere).
- pi.dev's own docs URLs: `https://pi.dev/docs/extensions` 404s; the site links to the GitHub repo.
  Canonical online mirrors: https://github.com/earendil-works/pi (packages/coding-agent/docs/) and
  https://github.com/earendil-works/pi-mono (referenced by session-format.md:31-36) — which of the
  two is the live repo was not verified from here.
