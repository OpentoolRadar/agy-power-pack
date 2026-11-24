# Global Background Task & Subagent Anti-Hang Watchdog Rules (`unattended-watchdog`)

To prevent asynchronous background commands, test suites, or subagents from stalling a workflow indefinitely (`waiting_for_dependents`) due to deadlocks, unclosed stdio handles, or network hangs, enforce these three layers of protection on every asynchronous workload.

## 1. Mandatory Conditional Watchdog at the Orchestration Layer (`schedule` + `TimerCondition`)
- **When required**: Whenever `run_command` transitions into a background task (returning a `taskId`), or whenever `invoke_subagent` / `send_message` launches a subagent expected to run longer than 60 seconds (returning a `conversationId`), **attach a one-shot watchdog timer via `schedule` before ending the turn to wait**:
  - `DurationSeconds`: Choose a realistic upper bound for the workload (`300`-`600`s for standard builds or single-package tests; `600`-`900`s for full-workspace suites or multi-stage subagents).
  - `TimerCondition`: **Bind directly to the target background `taskId` or subagent `conversationId`** (or `"any"` when waiting on multiple concurrent tasks/subagents). If the task finishes normally, the timer cancels automatically with zero extra overhead; if it hangs, the coordinator is forcibly woken up.
- **Standard self-healing procedure on watchdog wakeup**: Immediately inspect `manage_task(Action: "status")`, `manage_subagents(Action: "list")`, the tail of the subagent transcript/logs, and active OS processes:
  1. **Healthy progress** (logs actively advancing on a large build or test suite): arm another watchdog round and continue waiting.
  2. **Confirmed hang or deadlock** (logs frozen, process stuck on a lock, port, or binary): kill the wedged task/process immediately, isolate and fix the root cause, then re-verify. Never wait blindly forever.

## 2. Hard Process-Level Timeouts for Tests & Scripts
- **Protect runners without built-in kill timeouts**: Runners such as Rust `cargo test` (`libtest`), native binaries, and custom integration scripts do not enforce per-test hard kills by default. When running tests involving locks, file descriptors, child pipes, or local sockets:
  - Keep iteration loops fast by scoping to a single crate/package/test target first (e.g., `cargo test -p <crate>`).
  - Wrap full regressions or concurrency-heavy suites in an outer process timeout:
    - **Linux / macOS**: `timeout -k 10s <seconds>s <command>`
    - **Windows (PowerShell)**: `Start-Process -PassThru` with `Wait-Process -Timeout <seconds>`, printing lingering child command lines and running `Stop-Process -Force` with a non-zero exit code on timeout.
    - Or enable runner-native hard timeouts where available (`pytest --timeout`, Playwright `--timeout`, Go `go test -timeout`).
- **Brief subagents explicitly**: When dispatching build/test work via `invoke_subagent`, remind the subagent never to run unbounded interactive/blocking commands and to diagnose hangs proactively instead of waiting passively.

## 3. Deadlock-Free Concurrency & Multi-Threaded Test Design
- **Never panic or return before barrier arrival**: In tests using fixed-party barriers (`std::sync::Barrier`, `WaitGroup`, `CountDownLatch`), **never call `.unwrap()`, `.expect()`, `assert!`, or early `return` in a worker thread before calling `barrier.wait()`**:
  - Correct pattern: capture the result first, synchronize at the barrier, and assert afterward (e.g., `let res = acquire_lock(); hold_barrier.wait(); let guard = res.expect("...");`). This guarantees a single worker failure never leaves the main thread and sibling workers permanently stranded at the barrier.
- **Bound all channel and pipe waits**: In tests using cross-thread channels or child process `stdin`/`stdout` pipes, ensure senders/handles drop cleanly on error paths and guard blocking reads with `recv_timeout` / `tokio::time::timeout` (or language equivalents) so every failure exits deterministically with a clear error instead of hanging the process.
