# Repository Instructions

- Use Conventional Commits: `<type>: <summary>`; keep subjects factual and neutral.
- Never commit credentials, private backend addresses, personal deployment configuration, real transcripts, or runtime state. Keep local configuration in ignored environment files.
- Preserve existing work. Do not reset history, publish remote changes, restart an existing deployment, or send external messages without authorization.
- Source checkout, built artifact, running process, health, and real client behavior are separate evidence boundaries. State which were verified.

## Documentation

- Use `docs/README.md` as the documentation index and classification policy.
- Read the relevant `docs/specs/` before protocol changes. Update the spec and meaningful regression tests together.
- Keep repeatable setup and troubleshooting in `docs/runbooks/`.
- Keep `TODO.md` as a short backlog of links and `README.md` focused on users.
- Record technical findings in repository documentation; omit private incident transcripts and host-specific evidence from public files.

## Protocol Maintenance

- `docs/specs/protocol-support.md` defines maintenance scope.
- Responses is the primary OpenAI compatibility target. Codex and OpenClaw are the main real-harness acceptance paths.
- Chat Completions and Anthropic Messages are best effort. Do not expand Responses work into endpoint-specific alignment unless requested, or add parallel state paths solely to preserve their prior behavior.
- Shared behavior changes may affect all endpoints. Describe actual coverage and limitations without claiming complete conformance.
- Test meaningful behavior through the narrowest faithful public seam; mock external boundaries rather than the behavior under test.

## Trace Investigation

- Observation is best effort. Parsing, serialization, hashing, deduplication, or writing failures must not change business payloads, SDK admission, callbacks, streams, or terminal state.
- Treat a Viewer URL as a session identifier. Inspect persisted harness transcripts and bounded structured logs by exact full session ID before using browser automation.
- Codex transcripts are under `~/.codex/sessions/`; OpenClaw transcripts are under `~/.openclaw/agents/*/sessions/`. Do not copy real transcripts into the repository.
- Use browser automation for rendered behavior, interaction, or visual reproduction. The Bridge owns current runtime state; historical logs do not establish current pending ownership.

## Deployment

- Follow `docs/runbooks/local-deployment.md`. Supported deployment is local Docker Compose or local Node.js 24 LTS.
- Configuration and container builds do not authorize replacing an unrelated running deployment.
- Verify built assets, running process identity, health, and relevant behavior before claiming deployment success.
- Preserve the SDK's pinned version unless an upgrade is part of the task.
- Preserve required source attribution and dependency license notices.
