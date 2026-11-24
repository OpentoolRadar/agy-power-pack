# Visible Thinking Brief (`visible-thinking-brief`)

An always-on UX clarity plugin for **Google Antigravity** that ends the "staring at a collapsed `Thought for Xs` spinner while opaque tool calls fly by" problem — **in whatever language the user speaks**.

## What It Fixes

Out of the box, Antigravity collapses internal reasoning behind a summary toggle and streams raw tool invocations with little context. During long investigations or multi-file refactors, you end up watching a spinner wondering *what the agent just learned* and *why it is about to run that shell command*.

**Visible Thinking Brief** adds lightweight, high-signal transparency:

- **Pre-Tool Brief (1-2 Sentences)**: Before every tool call (or parallel tool batch), the agent writes a concise plain-prose update directly in the main response body stating what it just observed and what the next tool action will verify or change.
- **Zero Boilerplate Noise**: Prohibits repetitive prefixes or emoji banners (no `Thinking:`, no `Step 1:` spam) — just clean, readable engineering prose.
- **Clear Tool Summaries & Subagent Roles**: Keeps `run_command` summaries (`toolSummary`), subagent roles, and clarifying questions concise, concrete, and matched to the user's language.
- **Language-Agnostic**: Automatically mirrors the language of the conversation (English, Spanish, French, Japanese, etc.) while keeping code identifiers, CLI commands, and file paths verbatim.

## Installation

Copy this directory into `~/.gemini/config/plugins/visible-thinking-brief` (or run `./install.sh visible-thinking-brief` / `.\install.ps1 visible-thinking-brief` from the repository root), then enable **Visible Thinking Brief** under **Customizations -> Plugins** in Antigravity.

No external runtime dependencies are required.
