# Unattended Watchdog (`unattended-watchdog`)

An always-on reliability plugin for **Google Antigravity** that prevents background shell tasks, test suites, and subagents from silently freezing a session forever (`waiting_for_dependents`):

1. **Orchestration-Layer Conditional Watchdogs (`schedule` + `TimerCondition`)**: Before going idle to wait on a background command or long-running subagent, the coordinator must attach a one-shot timer bound to that task or subagent ID. Normal completion auto-cancels the timer with zero overhead; a hang wakes the agent for structured diagnosis and recovery.
2. **Process-Level Hard Timeouts**: Wraps test runners lacking built-in kill timeouts (e.g., `cargo test`, native binaries, custom scripts) with hard OS timeouts (`timeout -k 10s` on Linux/macOS or `Wait-Process -Timeout` + `Stop-Process -Force` on Windows).
3. **Deadlock-Free Concurrency Testing Patterns**: Prohibits panicking or early-returning inside worker threads before reaching a `Barrier` / `WaitGroup` / `CountDownLatch`, and requires bounded channel/pipe timeouts so failures terminate deterministically.

## Installation

Copy this directory into `~/.gemini/config/plugins/unattended-watchdog` (or run `./install.sh unattended-watchdog` / `.\install.ps1 unattended-watchdog` from the repository root), then enable **Unattended Watchdog** under **Customizations -> Plugins** in Antigravity.

No external runtime dependencies are required.
