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
   `http://localhost:5199/api/external-mcp/mcp`. If the session already started
   without the tools, don't restart it: drive that endpoint over raw HTTP
   ("Fallback: drive the MCP endpoint over raw HTTP").
2. Call `openchatcut_status`, then `list_projects`. Select a project only when
   the user names it or the current context identifies it.
3. Call `target_project` to bind this MCP transport session to the project.
   The project cannot be re-pointed, but calling `target_project` again
   recovers a stale binding — see "Recovering a stale binding" below.
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

This is the mirror image of the stale-binding hazard below: one is caused by
the editor starting too late, the other by the editor remounting too early.

A new agent session started while OpenChatCut is up gets the tools back, but it
is not the only fix — see the fallback below.

### Fallback: drive the MCP endpoint over raw HTTP

The empty tool registry blocks only the *native* call path. The server is a
plain streamable-HTTP MCP endpoint, so an agent with a shell can speak to it
directly and reach all the same tools without restarting the session.

Start OpenChatCut, then handshake:

```bash
curl -si -X POST http://localhost:5199/api/external-mcp/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -H "x-openchatcut-mcp-client: claude-code" \
  -H "x-openchatcut-mcp-surface: external" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"claude-code","version":"1"}}}'
```

Four rules make this work:

- Capture the **`mcp-session-id` response header** from `initialize` and send it
  on every subsequent request. That header *is* the transport session — the
  `target_project` binding lives on it, so a call that omits it lands on a
  fresh unbound session.
- Send `notifications/initialized` (no `id`) once before the first
  `tools/call`, or the server rejects tool calls as pre-handshake.
- Send both `x-openchatcut-mcp-*` headers on **every** request, not just
  `initialize`.
- Responses come back as `text/event-stream`. Parse by stripping the `data: `
  prefix off the last non-blank line, then reading `result.content[].text`.
  Check `result.isError` as well as the JSON-RPC `error` member.

Then `tools/call` as usual:

```bash
curl -s -X POST http://localhost:5199/api/external-mcp/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -H "x-openchatcut-mcp-client: claude-code" \
  -H "x-openchatcut-mcp-surface: external" \
  -H "mcp-session-id: $SID" \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"list_projects","arguments":{}}}'
```

Everything else in this skill applies unchanged over this path: the same call
order, the same binding semantics, the same reload hazard, the same stale
recovery. Write the curl invocation into a small wrapper script once, then call
tools as `<script> <tool_name> '<json args>'`.

Prefer the native path when you can get it — starting OpenChatCut before the
agent session is still less friction. Use this when the session is already
underway and restarting it would cost more than it saves.

## Call order and the reload hazard

Strict order, one step at a time:

```text
openchatcut_status -> list_projects -> target_project
  -> load_skill (optional) -> begin_edit_session -> read/edit tools
  -> review_edit_session -> get_edit_session
```

`target_project` binds to a specific `editorInstanceId` **and `baseRevision`**.
Anything that remounts the editor page mints a new instance id, and anything
that changes the project bumps the revision. Either one invalidates the binding
and later calls return `stale`.

Avoiding the remount is still worth it — it costs you the draft. But a stale
binding is no longer fatal; see below.

Therefore, after the editor tab is open:

- Never navigate, reload, or re-`preview_start` the editor URL. Navigating to
  the URL the tab is already on still remounts it.
- Read the editor through `read_page` / `get_page_text` / screenshots only.
- Never batch `target_project` or `begin_edit_session` in the same parallel
  call block as a browser navigation — the reload can land first.
- Open the editor tab *before* `target_project`, never after.

## Recovering a stale binding

A `stale` outcome usually means the editor's **revision** moved, not that the
tab remounted. An autosave, a user edit, or a media fallback (for example the
preview proxy failing over to the original file on a very large asset) is
enough to bump it. This can happen with no agent action at all.

Recovery is in-session — do **not** ask the user to restart the agent:

```text
openchatcut_status        -> reports stale:true plus a recovery hint
target_project (same id)  -> rebinds to the editor's current revision
begin_edit_session        -> start a fresh draft
```

`openchatcut_status` always answers, even for a stale session, so it is the
right first call when anything returns `stale`. Any `editSessionId` created
before the rebind is rejected afterwards — the draft was based on the old
revision, so redo it rather than trying to resume it.

Only start a new MCP session if the rebind itself fails, which means the
project is genuinely no longer open in a connected editor.

**Read the transcript early.** On a multi-GB source, do `read_transcript` /
`read_project` in the first calls after `begin_edit_session`, before the
preview has a chance to fail over and bump the revision underneath you.

## Skill version

`2026-08-03.1`

The OpenChatCut MCP server announces its required skill baseline. If the server
baseline is newer, run:

```bash
npx skills update openchatcut
```

Fallback command:

```bash
npx skills add 0xsline/OpenChatCut --skill openchatcut
```
