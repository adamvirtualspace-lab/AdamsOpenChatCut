---
name: openchatcut
description: Connect an MCP-capable coding agent to OpenChatCut and edit local video projects. Use when the user asks to install, connect, or set up OpenChatCut; inspect or edit an OpenChatCut project; work with its timeline, transcript, captions, media, generation, motion graphics, audio, color, or export tools; or recover from an OpenChatCut MCP error.
---

# OpenChatCut

OpenChatCut is a local-first, agent-native video editor. This skill is the
single external entry point; specialized editing guidance remains inside the
running editor and is loaded on demand with `load_skill`.

## Route the task

- Install, connect, or diagnose the MCP server: read
  `references/getting-started.md`.
- Inspect or modify a project: read `references/editing-workflow.md`.
- Recover from a failed tool call, stale session, or missing editor:
  read `references/known-errors.md`.

## Essentials

1. Start OpenChatCut **before starting the agent session** — see "Startup
   order" below. The default MCP endpoint is
   `http://localhost:5199/api/external-mcp/mcp`.
2. Call `openchatcut_status`, then `list_projects`. Select a project only when
   the user names it or the current context identifies it.
3. Call `target_project` to bind this MCP transport session to the project.
   The binding is permanent for the session and cannot be re-pointed.
4. Call `load_skill` before specialized work. It is read-only and requires
   neither `begin_edit_session` nor `editSessionId`; available names and support
   files come from the live MCP tool description.
5. Before project reads or edits, call `begin_edit_session`. Keep its
   `editSessionId` and pass it to every draft-safe editor tool.
6. Use `approvalMode: "manual"` unless the user explicitly asks for unattended
   application. In manual mode, the user approves the complete proposal in
   OpenChatCut. In auto mode, `review_edit_session` applies the complete draft.
7. Finish with `review_edit_session`. Report success only after
   `get_edit_session` returns `applied`.

## Startup order

MCP tool schemas attach only when the agent session starts. If OpenChatCut is
not already running at that moment, the `openchatcut` server fails its initial
connect and **no `openchatcut_*` tools exist for the entire session** — the
editor is reachable in a browser, but nothing can drive it. Starting the server
later in the session does not backfill the tools.

So the correct sequence is:

```text
start OpenChatCut  ->  start the agent session  ->  open the editor tab
  ->  target_project  ->  ...
```

Two things that look like progress but are not:

- `claude mcp list` reporting `openchatcut ✔ Connected` proves only that the
  endpoint answers a fresh health-check connection. It says nothing about the
  current session's toolset.
- Re-registering the server (`claude mcp remove` / `add`) does not attach tools
  to a session already underway — and `add` defaults to `--scope local`, which
  writes `~/.claude.json` instead of the repo's tracked `.mcp.json` and drops
  the required `x-openchatcut-mcp-client` / `x-openchatcut-mcp-surface`
  headers. Restore `.mcp.json` from git rather than re-adding via the CLI.

The only fix is a new agent session started while OpenChatCut is up. This is
the mirror image of the stale-binding hazard below: one is caused by the editor
starting too late, the other by the editor remounting too early.

## Call order and the reload hazard

Strict order, one step at a time:

```text
openchatcut_status -> list_projects -> target_project
  -> load_skill (optional) -> begin_edit_session -> read/edit tools
  -> review_edit_session -> get_edit_session
```

`target_project` binds to a specific `editorInstanceId`. Anything that
remounts the editor page mints a new instance id and permanently invalidates
the binding — every later call, including `openchatcut_status` and a repeat
`target_project`, returns `stale`. Only a brand-new MCP session recovers it.

Therefore, after the editor tab is open:

- Never navigate, reload, or re-`preview_start` the editor URL. Navigating to
  the URL the tab is already on still remounts it.
- Read the editor through `read_page` / `get_page_text` / screenshots only.
- Never batch `target_project` or `begin_edit_session` in the same parallel
  call block as a browser navigation — the reload can land first.
- Open the editor tab *before* `target_project`, never after.

## Skill version

`2026-08-01.1`

The OpenChatCut MCP server announces its required skill baseline. If the server
baseline is newer, run:

```bash
npx skills update openchatcut
```

Fallback command:

```bash
npx skills add 0xsline/OpenChatCut --skill openchatcut
```
