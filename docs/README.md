# Documentation

Start with the [English README](../README.md) or [中文 README](../README.zh-CN.md)
for Docker quick start, client configuration, features, and known limits.

## Setup and troubleshooting

- [Local Docker and source deployment](runbooks/local-deployment.md)
- [Trace Viewer](runbooks/trace-viewer.md)

## Protocol and implementation contracts

These references describe current behavior for contributors and client integrators.

- [Protocol support and maintenance scope](specs/protocol-support.md)
- [Responses Agent context affinity](specs/responses-agent-context-affinity.md)
- [Grok hybrid Responses routing](specs/grok-hybrid.md)
- [Cursor SDK event normalization](specs/sdk-event-normalization.md)
- [SDK tool batches and continuation](specs/sdk-tool-continuation.md)
- [Responses steering turns](specs/responses-superseding-turns.md)
- [Responses failure trace artifacts](specs/responses-failure-traces.md)
- [Responses runtime trajectory](specs/responses-runtime-trace-signatures.md)
- [Cursor SDK executor and pending Run lifecycle](specs/sdk-executor-lifecycle.md)

Protocol changes should update the relevant contract and regression coverage
together. See [repository instructions](../AGENTS.md) and the [roadmap](../TODO.md).
