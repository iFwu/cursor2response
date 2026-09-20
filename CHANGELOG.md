# Changelog

## Unreleased

- Replace `grok-hybrid` and `grok-hybrid-fast` with `cursor-auto`. Both the
  Cursor primary and external Responses model are explicitly configured with
  `C2R_PRIMARY_MODEL`, `C2R_FALLBACK_BASE_URL`, `C2R_FALLBACK_API_KEY` and
  `C2R_FALLBACK_MODEL`. Old aliases and environment keys are removed.
- Route state now includes the configured primary and fallback target and lives
  in `fallback-routes`. Existing deployments must migrate active route markers
  and update client/gateway model selection before switching; old markers are
  not automatically read. Configure `C2R_FALLBACK_NOTIFY_COMMAND` to opt into
  external notifications.

The initial cursor2response source snapshot establishes a local Responses-focused gateway, SDK Bridge, and Trace Viewer.

This changelog describes public cursor2response releases. It does not carry forward private deployment history or earlier desktop application releases.
