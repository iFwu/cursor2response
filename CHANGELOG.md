# Changelog

## Unreleased

- Preserve Grok 4.7's `reasoning_effort` parameter through Sidecar and Bridge,
  and honor `service_tier: "default"` by disabling Fast where supported. Local
  SDK validation accepts 256k; advertised 500k mode remains unavailable.
- Replace `grok-hybrid` and `grok-hybrid-fast` with `cursor-relay` (Cursor Relay). Both the
  Cursor primary and external Responses model are explicitly configured with
  `C2R_PRIMARY_MODEL`, `C2R_FALLBACK_BASE_URL`, `C2R_FALLBACK_API_KEY` and
  `C2R_FALLBACK_MODEL`. The Grok aliases and old environment keys are removed.
- Existing `cursor-auto` clients remain compatible through an unlisted migration
  alias. Both IDs preserve the existing `cursor-auto` sticky route namespace;
  remove the request alias after all clients and gateways migrate.
- Route state now includes the configured primary and fallback target and lives
  in `fallback-routes`. Deployments using the earlier `grok-hybrid` state format
  must migrate active route markers and update client/gateway model selection
  before switching; those markers are not automatically read. Configure
  `C2R_FALLBACK_NOTIFY_COMMAND` to opt into external notifications.

The initial cursor2response source snapshot establishes a local Responses-focused gateway, SDK Bridge, and Trace Viewer.

This changelog describes public cursor2response releases. It does not carry forward private deployment history or earlier desktop application releases.
