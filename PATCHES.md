# Upstream patch stack

This checkout is an upstream-tracking fork. Upstream is authoritative; `main` is a pristine mirror, and the customization is an ordered StGit stack on `openai-native-controls`.

- **Upstream:** `https://github.com/earendil-works/pi.git`
- **Fork/origin:** `git@github.com:TiagoJacinto/pi.git`
- **Patch branch:** `openai-native-controls`
- **Pristine branch:** `main`, tracking `upstream/main`
- **Current base:** `d5629e204` (moves forward with `upstream/main`)
- **Stack tool:** StGit (`stg`; StGit 0.19 was verified here; it is maintainer-only)
- **Conflict memory:** repository-local `rerere.enabled=true`, `rerere.autoupdate=true`

## Invariants to preserve

- Pi core owns generic agent behavior: optional active-response steering and opt-in early tool dispatch reuse the existing agent loop and executor.
- OpenAI Responses WebSocket events, IDs, replay, `async: true`, `response.steer`, and `configuration_update` stay in `packages/ai`.
- Native steering falls back to Pi's queued steering when no active compatible response exists.
- Async results preserve the original `call_id`; `response_id` is separate continuation state.
- Reasoning request effort stays pinned for a provider/model/context window; configuration updates change effective effort. Model/provider changes and successful compaction establish a new baseline.
- A no-`sessionId` request uses an ephemeral socket and safe history replay, never a dead socket's `previous_response_id`.
- Async tools, native steering, and reasoning updates are independently represented capabilities; transport availability gates runtime use separately.

## Patch stack

The stack keeps eight logical behavior patches, one dedicated `pi-gpt-6` CLI/update patch, and the final fork-specific documentation patch. Keep the documentation patch last. The CLI/update patch is fork-maintenance infrastructure; do not mix it into behavior patches. Behavior patches may disappear as upstream implements them, while the fork CLI and final maintenance guidance remain. Tests stay with the behavior they protect.

| Patch (in order) | Purpose / why Pi differs | Main files and regression coverage |
|---|---|---|
| `feat(ai): add OpenAI Responses native controls` | Adds direct Responses WebSocket protocol, model capability metadata, and reasoning update serialization. | `packages/ai/src/api/openai-responses.ts`, `openai-responses-shared.ts`, model generator/types; `packages/ai/test/openai-responses-native-controls.test.ts`, feature spec. |
| `feat(agent): dispatch async tools and native steering` | Adds generic active-response control and early async-tool dispatch through Pi's existing executor. | `packages/agent/src/agent-loop.ts`, `agent.ts`, `types.ts`; agent loop/agent tests. |
| `feat(coding-agent): persist reasoning effort updates` | Retains effective effort and baseline context in session history. | `packages/coding-agent/src/core/agent-session.ts`, `session-manager.ts`; session context tests. |
| `fix(openai): keep forced SSE tool calls synchronous` | Ensures model capability alone cannot enable WebSocket-only async behavior when SSE is forced. | AI provider and agent loop; native-controls test. |
| `fix(ai): harden Responses control lifecycle` | Handles abort, socket lifecycle, pending steering and response continuation safely. | Responses provider/shared types; native-controls tests. |
| `fix(agent): dispatch native controls at stream start` | Makes the active controller available before early stream events can arrive. | Agent loop; focused agent tests. |
| `fix(coding-agent): pin reasoning baseline at compaction` | Re-establishes baseline only for a successful new context window. | Session manager; compaction/context tests. |
| `fix(openai): verify ephemeral Responses controls` | Proves capability independence, full-history replay, late async results and ephemeral steering expiry. | Model generator, Responses provider and coding-agent compaction behavior; native-controls/compaction tests. |
| `feat: install pi-gpt-6 fork CLI` | Installs an independent PATH command, delegates normal Pi commands, and stages/validates fork releases before atomic activation. | `scripts/pi-gpt-6.mjs`, `scripts/install-pi-gpt-6.sh`; `scripts/pi-gpt-6.test.mjs`, CLI feature spec. |
| `maint: document upstream patch stack` | Keeps this fork's update procedure and behavioral invariants discoverable to future agents. | `PATCHES.md`, `AGENTS.md`, `scripts/update-from-upstream.sh`. |

## Using the fork CLI

Install the stable fork build and PATH command from this checkout with `scripts/install-pi-gpt-6.sh`. Normal `pi` remains untouched. The launcher is `~/.local/bin/pi-gpt-6`; its stable releases live under `~/.local/share/pi-gpt-6/releases/`, with `current` selecting the active release and older releases retained for rollback. The source checkout remains this repository and is used only for fork maintenance, never for normal execution.

```sh
pi                         # normal Pi
pi-gpt-6                   # patched fork
pi-gpt-6 update            # update fork from upstream and replay this stack
pi-gpt-6 update --extensions
pi-gpt-6 update --all      # normal package update plus fork update
pi-gpt-6 update --agent    # opt-in semantic repair of an outstanding patch conflict
```

Other commands and options pass through to the installed fork. `update --self`, `update self`, and `update pi` update the fork; package/model-only update forms keep Pi's existing behavior. A fork update never publishes the rebased patch branch. On conflict, the installed release stays active and the prompt is saved in the repository's Git metadata directory.

To inspect current differences from upstream: `git diff upstream/main...openai-native-controls`.
To inspect ordinary patch commits: `git log --oneline upstream/main..openai-native-controls`.
To inspect StGit state: `stg series` (`+` means applied; `>` is the top applied patch).

## When behavior lands upstream

This fork preserves missing behavior, not patches forever. On each update ask whether upstream now implements the capability, offers a better generic abstraction, or lets the patch shrink or disappear. Before resolving a conflict, inspect the new upstream implementation and check whether it already provides some or all of the patch's behavior. Preserve the patch's intent in the new architecture; never mechanically restore the old diff. If behavior is equivalent, adapt or shrink the patch instead of restoring redundant code. If fully obsolete, verify behavior and tests, retain useful regression tests where appropriate, then remove the StGit patch and inspect the final diff.

The final maintenance patch is intentionally fork-specific: keep it last even when the behavior stack reaches zero patches.

## Known test-environment / upstream behavior

Hydrated current model data has produced an image-model count mismatch in the full AI suite. Timing-sensitive tests have failed in broad runs but passed in isolation or reruns; remote-runtime socket tests can depend on environment/runtime behavior. Credential- or service-dependent model tests also need a base comparison. Never call a failure unrelated based on appearance: establish that it reproduces on upstream/base, that affected code is unchanged and a rerun evidences flakiness, or that it is demonstrably external/credential/service dependent. Fix failures caused by this patch stack; do not edit upstream tests just to silence unrelated failures.

## Updating from upstream

Start by reading the invariants, then run this exact sequence from the repository root:

```sh
git switch openai-native-controls
cat PATCHES.md
git status --short
scripts/update-from-upstream.sh
```

The status must be clean. The script fetches both remotes, fast-forwards local `main` to `upstream/main`, then runs `stg rebase --merged upstream/main`. It never pushes either fork branch, guesses conflict resolutions, deletes patches, changes tests, or force-pushes. If `main` cannot fast-forward, it stops rather than rewriting it. Runtime updates are local operations; publishing is an explicit maintainer action (for example, `git push origin main` and, after reviewing a rewritten stack, `git push --force-with-lease origin openai-native-controls`).

Update and review in this order:

1. Switch to `openai-native-controls`.
2. Read `PATCHES.md`.
3. Verify the worktree is clean.
4. Run `scripts/update-from-upstream.sh`.
5. On conflict, read that patch's purpose and invariants here.
6. Inspect the new upstream implementation.
7. Determine whether the patch is still needed, partly or wholly.
8. Preserve intent using the new upstream architecture; shrink redundant code.
9. Stage the resolved paths.
10. Run `stg refresh` for the current patch.
11. Continue replay with `stg push --all`.
12. Inspect `stg series`; keep the maintenance patch last.
13. Inspect `git diff upstream/main...openai-native-controls`.
14. Hydrate/build if needed, run targeted tests, `npm run check`, then broad tests (`./test.sh`).
15. Classify failures only with evidence as described above; review the complete remaining diff.
16. Push only after validation. If replay rewrote a published branch, explicitly review and use `git push --force-with-lease origin openai-native-controls`.

The source update script does not push, guess resolutions, delete patches, or modify tests. The `pi-gpt-6` launcher additionally builds and validates an isolated release before switching `current`; only after atomic activation does it retain the current release plus the five newest previous releases. A failure before activation leaves the prior release active and skips cleanup. Runtime updates never publish fork branches; publishing is an explicit maintainer action.

Do not routinely merge upstream into the patch branch. Preserve behavior, not historical diffs. Never force-push `main`.
