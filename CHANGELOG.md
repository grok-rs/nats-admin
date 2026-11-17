# Changelog

## 0.2.0

### Connections & safety
- NATS CLI contexts, NATS_URL and team connections (`nats.connections`) appear automatically and stay in sync; the selected CLI context is marked ★; local servers are detected.
- Environments (dev / test / staging / prod) with colours across the tree, status bar, terminals and dashboards; typed confirmation for destructive actions on production.
- Read-only mode that blocks every write and opens KV / config editors read-only.
- Secret prompting for team connections, `.creds` expiry warnings, auto-connect and restore on startup.

### Dashboards & visuals
- New design system and chart library (time series, gauges, treemaps, histograms, heatmaps…) that follows light, dark and high-contrast themes.
- NATS Home (fleet view), Overview sidebar, redesigned server dashboard, stream dashboard, cluster overview and an interactive topology graph.
- KV Browser overview charts (size histogram, type donut, prefix treemap, activity).
- Themed, slim scrollbars in all panels.

### Operations
- Health check with a dashboard, badges in the tree, a status bar score and Markdown reports.
- Explorer auto-refresh from JetStream advisories; Subjects node with per-subject counts.
- Consumer pause / resume / reset; nats CLI terminal and "copy CLI command".
- Config as code: JSON schemas, export, compare, apply and a plan view with drift detection; KV import / export.
- Message Browser works on work-queue streams and for users without consumer permissions.
- Getting Started walkthrough.

## 0.1.0

First release.

- Connection profiles: user/password, token, creds, NKey, TLS/mTLS, NATS CLI context import, Test Connection; secrets in SecretStorage.
- Explorer tree: server, streams → consumers, KV buckets → hierarchical keys, object stores → objects, micro-services → endpoints.
- Key-Value: values open as editable documents (pretty JSON round-trip, revision-based conflict detection, live reload), history with diff and restore, KV Browser with structure analysis and live watch.
- Streams and consumers: creation wizards, JSON config editing, purge variants, Message Browser, Consumer Lab.
- Messaging: Live Tail, Publisher / Request-Reply with templates, Publish Selection, Dead Letter Monitor.
- `.nats` playbooks with CodeLens, highlighting and diagnostics.
- Server Dashboard backed by the HTTP monitoring endpoint.
