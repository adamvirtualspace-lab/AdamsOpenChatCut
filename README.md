
## 🍴 About this fork

This repository is a **fork of [0xsline/OpenChatCut](https://github.com/0xsline/OpenChatCut)**, with additional local-first tooling layered on top. Every upstream feature is preserved and the branch is kept in sync with upstream `main`; the additions are opt-in and backwards-compatible.

**What this fork adds:**

- **Local / offline transcription** — Whisper running on your own machine via **whisper.cpp** (GPU-capable) or the bundled **transformers.js** (CPU), auto-selected. No cloud API key required, and the original AssemblyAI path is unchanged.
- **SRT / VTT import** — attach an existing subtitle file as a word-level transcript instead of re-transcribing.
- **Transcript UX** — a delete-transcript action, a one-click "make captions from the current transcript" button, and deletable caption tracks.
- **i18n fixes** — the app starts in your browser's language instead of always Chinese; agent replies and proposal-card labels are localized.

See the [Local Transcription](#local-transcription-offline-gpu-optional) section for details and configuration.

*Everything below is the upstream OpenChatCut README.*

---

<p align="center">
  <img src="public/openchatcut-icon.png" width="96" alt="OpenChatCut" />
</p>

<h1 align="center">OpenChatCut</h1>

<p align="center">
  <a href="README_ZH.md">简体中文</a> · <strong>English</strong>
</p>

<p align="center">
  <strong>Open-source ChatCut alternative · agent-native · local-first AI video editor</strong>
</p>

<p align="center">
  Let Codex, Claude Code, and the built-in agent read, edit, and export real video projects that remain fully editable.
  Website: <a href="https://openchatcut.com">openchatcut.com</a>
</p>

<p align="center">
  <a href="#what-is-openchatcut">Introduction</a> ·
  <a href="#product-tour">Product Tour</a> ·
  <a href="#quick-start">Quick Start</a> ·
  <a href="#local-transcription-offline-gpu-optional">Local Transcription</a> ·
  <a href="#using-openchatcut-with-codex--claude-code">Agent / MCP</a> ·
  <a href="#community">Community</a> ·
  <a href="#sponsor">Sponsor</a> ·
  <a href="#changelog">Changelog</a> ·
  <a href="#star-growth">Star Growth</a> ·
  <a href="#contributing">Contributing</a>
</p>

<p align="center">
  <a href="https://github.com/0xsline/OpenChatCut"><img alt="GitHub Repository" src="https://img.shields.io/badge/GitHub-Repository-181717?style=flat&logo=github" /></a>
  <a href="https://discord.gg/bSGUAeWYkh"><img alt="Discord Community" src="https://img.shields.io/badge/Discord-Join_Community-5865F2?style=flat&logo=discord&logoColor=white" /></a>
  <img alt="Status" src="https://img.shields.io/badge/status-active_development-FF8A3D?style=flat" />
  <img alt="Local First" src="https://img.shields.io/badge/data-local_first-111827?style=flat" />
  <img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-6-3178C6?style=flat&logo=typescript&logoColor=white" />
  <img alt="React" src="https://img.shields.io/badge/React-19-149ECA?style=flat&logo=react&logoColor=white" />
  <img alt="Remotion" src="https://img.shields.io/badge/Remotion-4-0B84F3?style=flat" />
  <img alt="Electron" src="https://img.shields.io/badge/Electron-43-47848F?style=flat&logo=electron&logoColor=white" />
  <img alt="MCP" src="https://img.shields.io/badge/MCP-Agent_native-7C3AED?style=flat" />
</p>

<p align="center">
  <a href="https://linux.do" alt="LINUX DO"><img src="https://shorturl.at/ggSqS" /></a>
</p>

<p align="center">
  <a href="https://www.producthunt.com/products/openchatcut?embed=true&amp;utm_source=badge-featured&amp;utm_medium=badge&amp;utm_campaign=badge-openchatcut" target="_blank" rel="noopener noreferrer"><img alt="OpenChatCut - Open-source AI agent video editor with a real timeline | Product Hunt" width="250" height="54" src="https://api.producthunt.com/widgets/embed-image/v1/featured.svg?post_id=1201995&amp;theme=light&amp;t=1784645557617" /></a>
</p>

<p align="center">
  <img src="assets/readme-pic/01-editor-overview.png" alt="OpenChatCut editor overview with the agent workspace, media pool, preview, and multitrack timeline" />
</p>

<p align="center">
  <sub>From a single instruction to a real timeline: agents, media, previews, motion graphics, transitions, effects, and multitrack audio all work together in one project.</sub>
</p>

---

## 🍴 About this fork

This repository is a **fork of [0xsline/OpenChatCut](https://github.com/0xsline/OpenChatCut)**, with additional local-first tooling layered on top. Every upstream feature is preserved and the branch is kept in sync with upstream `main`; the additions are opt-in and backwards-compatible.

**What this fork adds:**

- **Local / offline transcription** — Whisper running on your own machine via **whisper.cpp** (GPU-capable) or the bundled **transformers.js** (CPU), auto-selected. No cloud API key required, and the original AssemblyAI path is unchanged.
- **SRT / VTT import** — attach an existing subtitle file as a word-level transcript instead of re-transcribing.
- **Transcript UX** — a delete-transcript action, a one-click "make captions from the current transcript" button, and deletable caption tracks.
- **i18n fixes** — the app starts in your browser's language instead of always Chinese; agent replies and proposal-card labels are localized.

See the [Local Transcription](#local-transcription-offline-gpu-optional) section for details and configuration.

*Everything below is the upstream OpenChatCut README.*

---

## What is OpenChatCut?

OpenChatCut is an **open-source ChatCut alternative**: a video editor that brings **conversational agents** and **professional timeline editing** into the same workspace. It is independent open source (AGPL), not affiliated with the commercial ChatCut product.

**OpenChatCut = local video projects + multitrack timeline + AI agents + MCP + production-ready exports.**

It does not merely generate a video that can no longer be changed. Every edit is written to real tracks, clips, transitions, captions, effects, and media inside the project. You can continue editing manually, undo or redo changes, save versions, or hand the project to another agent.

OpenChatCut is built for creators and developers who want AI to participate in the actual editing workflow without giving up professional control, rather than starting over from an empty chat box or an immutable generated result.

- Website: [https://openchatcut.com](https://openchatcut.com)
- Open-source ChatCut alternative guide: [https://openchatcut.com/blog/open-source-chatcut-alternative](https://openchatcut.com/blog/open-source-chatcut-alternative)
- ChatCut vs OpenChatCut: [https://openchatcut.com/blog/chatcut-vs-openchatcut](https://openchatcut.com/blog/chatcut-vs-openchatcut)

- 🤖 **Agent-native**: the built-in agent and external MCP agents share the same editing tools.
- 🎞️ **Real timeline**: multiple video and audio tracks, transitions, effects, LUTs, zooms, and keyframes.
- 📝 **Transcript-driven editing**: word-level transcription (cloud **or** local/offline Whisper), SRT/VTT import, text-based cuts, pause handling, speakers, and linked captions.
- ✨ **Generation and media**: images, video, speech, music, sound effects, and online media search.
- 🧩 **Motion Graphics and WebGL**: editable motion templates, custom shaders, visual effects, and transitions.
- 📦 **Production-ready exports**: MP4, audio, captions, FCPXML, and complete project data.
- 🖥️ **Local-first**: projects and media stay on your machine by default, while API keys remain server-side.
