# NATS Admin — User Guide

This guide covers every feature of the extension. For a visual tour see the [README](../README.md).

- [Connections](#connections)
- [Environments, read-only mode and safety](#environments-read-only-mode-and-safety)
- [The NATS view](#the-nats-view)
- [Dashboards](#dashboards)
- [Health check](#health-check)
- [Key-Value](#key-value)
- [Streams and consumers](#streams-and-consumers)
- [Messaging](#messaging)
- [Object Store and services](#object-store-and-services)
- [Config as code](#config-as-code)
- [Playbooks (`.nats` files)](#playbooks-nats-files)
- [nats CLI integration](#nats-cli-integration)
- [Settings](#settings)
- [Commands](#commands)
- [Troubleshooting](#troubleshooting)

## Connections

Connections come from four sources, all shown together in the **Connections** view:

| Source | How it appears | Where secrets live |
| --- | --- | --- |
| **NATS CLI contexts** (`~/.config/nats/context/*.json`, or `nats.contexts.directory`) | Automatically, live-synced with the files. The context chosen with `nats context select` (or `NATS_CONTEXT`) gets a ★ | In the context file (as for the CLI) |
| **Workspace connections** (`nats.connections` in `.vscode/settings.json`) | Automatically, in trusted workspaces only | Asked for on first connect, then kept in the OS keychain |
| **Environment** (`NATS_URL`, `NATS_USER`, `NATS_PASSWORD`, `NATS_CREDS`, `NATS_NKEY`, `NATS_CA`, `NATS_CERT`, `NATS_KEY`) | As *NATS_URL (environment)* | The environment |
| **Saved connections** (**Add Connection**) | Created in the connection editor | OS keychain (VS Code SecretStorage) |

Authentication: none, user/password, token, `.creds` file (JWT + NKey), NKey seed or seed file, and JWT + seed (for contexts with `user_jwt`). TLS/mTLS options: CA, client certificate and key, SNI, *handshake first*, and *skip verification* (development only). Advanced options include the JetStream domain and API prefix, the inbox prefix (honoured by requests, KV watchers and consumers), timeouts and reconnect behaviour.

Example team connection, safe to commit:

```json
"nats.connections": [
  { "name": "Staging", "servers": ["tls://nats.staging.example.com:4222"], "auth": { "kind": "userpass", "username": "svc-admin" }, "environment": "staging" },
  { "name": "Production EU", "servers": "tls://nats-eu-1:4222,tls://nats-eu-2:4222", "auth": { "kind": "creds", "credsFile": "~/.nkeys/prod-eu.creds" }, "environment": "prod", "readOnly": true }
]
```

Other connection features:

- **Test Connection** in the editor reports the server, RTT, JetStream status and whether the monitoring endpoint is reachable.
- **Hide** discovered entries you don't need, and bring them back with **Show Hidden Connections**.
- **Save as VS Code Connection** copies a context into an editable profile.
- **Auto-connect** per connection, or `nats.connections.restoreOnStartup` to reopen whatever was connected last time.
- `.creds` expiry is shown in tooltips; you get a warning 7 days before expiry and a clear message once expired.
- When no connection exists and a NATS server answers on `localhost:4222`, the view offers **Connect to localhost**.

## Environments, read-only mode and safety

**Set Environment…** labels a connection `dev`, `test`, `staging` or `prod`. Names and descriptions such as `prod-eu`, `production`, `staging`, `uat`, `qa`, `local` or `dev` are recognised automatically. The environment colours the tree label (with a P/S/T/D badge), the status bar, terminals and dashboard headers.

On **production** connections, every destructive action requires typing the resource name: deleting or purging streams, consumers, buckets, keys and objects, resetting consumers, and applying configs. These confirmations cannot be disabled.

**Toggle Read-Only Mode** blocks every write:

- publishing, replies and republishing;
- KV puts, deletes and purges;
- creating, updating, deleting and purging streams and consumers;
- object uploads and deletes;
- Consumer Lab fetches and acks;
- applying configs.

KV and config documents open read-only. Browsing, subscriptions and request/reply keep working. The change takes effect immediately, even on open connections.

## The NATS view

- **Overview** (sidebar webview): the active connection with environment strip, status, RTT sparkline, msgs/s, JetStream usage meters, resource counts, health score and quick actions.
- **Connections** (tree): connection → Server · Streams (→ Subjects, consumers) · Key-Value (→ hierarchical keys) · Object Store (→ objects) · Services (→ endpoints) · Servers (with system-account access).
  The tree refreshes itself from JetStream advisories when streams or consumers change elsewhere. For a periodic statistics refresh, set `nats.explorer.statsRefreshInterval`.
  Health problems appear as badges and colours on the affected items.
- **Health** (tree): findings per connection, grouped by severity, each with a recommendation and a fix.

The status bar shows the active connection, its environment, a read-only lock and the RTT; click it to switch. A second item shows the health score.

## Dashboards

| Dashboard | Open with | Shows |
| --- | --- | --- |
| **NATS Home** | `NATS: Open NATS Home` or the home icon | All profiles grouped by environment, fleet KPIs, per-connection throughput, storage and health, plus actions |
| **Server** | Click *Server* in the tree | Identity, msgs/s, bytes/s, CPU and RTT charts, JetStream account usage, client connections, streams ↔ subjects router |
| **Stream** | Graph icon on a stream | Ingest rate and bandwidth, limit gauges, throughput, consumer backlog, subject treemap and top subjects, replicas, mirrors and sources, recent messages |
| **Cluster** | `Open Cluster Overview` | Per-server CPU, memory and JetStream usage, routes, gateways and leaf nodes, and who you are (user, account, permissions) |
| **Topology** | `Open JetStream Topology` | Interactive graph: subjects → streams → consumers, KV and object buckets, mirrors and sources, service endpoints |
| **Health** | `Open Health Dashboard` | Score gauge, severity breakdown, findings by category and resource, best-practice guidance |

Dashboards poll only while visible (`nats.dashboard.refreshInterval`, `nats.overview.refreshInterval`). Message, byte, CPU and client figures come from the server's HTTP monitoring endpoint. It is derived as `http://<host>:8222`, or set it per connection under *Monitoring*.

## Health check

**Run Health Check** runs automatically after connecting (`nats.health.autoRun`), and periodically if `nats.health.intervalMinutes` is set. It collects server info, RTT, JetStream account info, all streams and consumers and, when reachable, `/varz` and `/healthz`. Permission errors are tolerated.

Checks include:

- unbounded streams;
- streams and the account near their limits (`nats.health.storageWarningRatio` / `storageErrorRatio`);
- single replicas in a cluster, even replica counts, lagging or leaderless replicas;
- mirror and source lag;
- interest streams without consumers;
- consumers behind by more than `nats.health.pendingWarning`, or ack pending at `ackPendingRatio` × max ack pending;
- redeliveries, and unlimited max deliver with explicit ack;
- unbound push consumers, and pull consumers without pullers;
- paused consumers;
- slow consumers;
- RTT above `nats.health.rttWarningMs`;
- servers older than 2.10, JetStream disabled, monitoring unreachable.

**Export Health Report** opens a Markdown report you can paste into tickets.

## Key-Value

- **Tree**: keys are grouped into folders by `nats.kv.keySeparator` (default `.`). Keys that are also prefixes stay openable. Apply a server-side **filter** per bucket (`app.>`, `*.url`).
- **Open a key** as a document (`nats-kv:`):
  - compact JSON is pretty-printed and stored compact again;
  - binary values open as a read-only hex view;
  - the document version is the KV revision, so concurrent changes trigger VS Code's compare/overwrite dialog;
  - open tabs live-reload.
- **History**: pick a revision, then compare it with the current value in the diff editor, open it, or restore it as a new revision.
- **KV Browser**:
  - a tree or sortable table of all keys with values, type badges and search;
  - live watch;
  - per key: value (JSON tree, text, hex, base64, MessagePack, Protobuf, gunzip), edit with compare-and-set, history and structure;
  - per bucket or prefix: size histogram, type donut, prefix treemap, activity strip, and the aggregated JSON structure (field paths, types, presence %, examples).
- **Import / export** keys as JSON: values are stored as JSON, text as strings, binary as `{"$base64": "…"}`.
- Create buckets (history, TTL, storage), view status, delete; add, delete and purge keys.

## Streams and consumers

- **Create Stream** wizard (name, subjects with overlap check, storage, retention, max age). **Edit Stream Config (JSON)** opens the full config; saving applies it, and server validation errors are shown.
- **Purge**: everything, by subject, keep newest N, or below a sequence. Delete. View stream info as JSON.
- **Subjects** node under each stream: message counts per subject as a hierarchy. Click to browse that subject.
- **Message Browser**:
  - Oldest / Older / Newer / Newest paging (filtered backward paging too), subject filter, jump to a sequence or time, follow mode;
  - payload viewer with headers;
  - republish, delete (optionally erase), export JSON/CSV.
  - Work-queue streams and users without consumer permissions are read through direct gets, so browsing never consumes messages.
- **Create Consumer** wizard: pull or push, deliver and ack policy. It warns when a filter doesn't overlap the stream and blocks deliver-subject loops. **Edit Consumer Config (JSON)**.
- **Pause / Resume / Reset Consumer**: pause and resume need nats-server 2.11+; reset needs a recent server.
- **Consumer Lab**: fetch batches, then ack / nak (with delay) / term (with reason) / in progress, per message or in bulk. Shows live pending, ack pending and redelivered counts and an ack-floor bar. Push consumers link to Live Tail.

## Messaging

- **Live Tail**:
  - several subscriptions with queue groups;
  - pause with host-side buffering, filter, msgs/s;
  - manual replies, including service-error replies;
  - republish, export JSON/CSV;
  - subscriptions are restored after a reconnect.
- **Publisher / Request-Reply**:
  - headers, payloads as text, JSON, base64 or hex, JSON validate and format;
  - templates;
  - bursts with an interval;
  - JetStream publish with PubAck;
  - request timeouts, recent sends, *copy as playbook block*.
- **Publish Selection to Subject** from any editor.
- **Dead Letter Monitor** decodes `MAX_DELIVERIES` / `MSG_TERMINATED` advisories, loads the original message, and can republish or delete it.

Templates: `{{uuid}}`, `{{seq}}`, `{{timestamp}}`, `{{date}}`, `{{unix}}`, `{{unixMs}}`, `{{random}}`, `{{random:1:100}}`, `{{randomString:12}}`.

## Object Store and services

- Object Store:
  - create and delete buckets;
  - upload files and download objects (streamed, with progress);
  - preview text, or open images, PDFs and media in VS Code's viewers;
  - object info, delete.
- Services: micro-services are discovered via `$SRV.INFO` / `$SRV.STATS`, with per-endpoint request, error and latency stats. **Send Request to Endpoint** opens the publisher in request mode.

## Config as code

| File | Content |
| --- | --- |
| `<STREAM>.stream.json` | StreamConfig, compatible with `nats stream add --config` |
| `<STREAM>.<CONSUMER>.consumer.json` | ConsumerConfig (the stream comes from the file name) |
| `<BUCKET>.kv.json` | `{ bucket, description, history, ttl, storage, replicas, max_bytes, max_value_size, compression, metadata }` |

- **Export JetStream Config to Workspace** writes these files. KV and object backing streams are exported as `.kv.json`, not `.stream.json`.
- JSON schemas give completion, validation and hover docs for every field. Durations are nanoseconds, as in the server API.
- CodeLens on each file: **Apply to <connection>**, **Compare with <connection>** (diff against the live server config to detect drift), and a target-connection switcher.
- **Plan & Apply Config Folder** shows create / update (key-level diff) / unchanged / drift / errors, then applies all or individual items. Production requires typed confirmation; read-only connections refuse.

## Playbooks (`.nats` files)

Saved, shareable requests with CodeLens, highlighting and diagnostics. **New Playbook** creates a sample.

```
@connection local

### Create an order (3 times, stored via JetStream)
PUB orders.eu.created count=3 js=true
Nats-Msg-Id: {{uuid}}

{"id": {{seq}}, "createdAt": "{{timestamp}}"}

### Ask for a quote
REQ billing.quote timeout=3000
{"sku": "A1"}

### Watch shipments
SUB orders.*.shipped count=10 timeout=30000 queue=workers
```

Options: `count=`, `timeout=`, `reply=`, `connection=`, `js=true`, `queue=`. Replies open as JSON documents beside the playbook. Subscription output goes to the *NATS Playbook* output channel.

## nats CLI integration

- **Open Terminal for nats CLI**: a terminal with `NATS_CONTEXT` set (for contexts), or `NATS_URL` plus credential and TLS variables. It is coloured by environment.
- **Copy nats CLI Command** on streams, consumers and buckets copies common commands with the right `--context` / `--server` flag.

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| `nats.explorer.showInternalStreams` | `false` | Show the streams backing KV buckets (KV_*) and Object Stores (OBJ_*) in the Streams folder. |
| `nats.kv.keySeparator` | `"."` | Character used to group KV keys into folders in the explorer tree (NATS subjects use '.'). Set to an empty string for a flat list. |
| `nats.kv.maxKeys` | `5000` | Maximum number of keys loaded per bucket in the explorer tree and KV Browser. |
| `nats.kv.prettyPrintJson` | `true` | Pretty-print compact JSON values when opening a KV key. On save, values that were compact are stored compact again. |
| `nats.messageBrowser.pageSize` | `50` | Number of messages per page in the Message Browser. |
| `nats.liveTail.maxMessages` | `2000` | Maximum number of messages kept in a Live Tail panel (older messages are dropped). |
| `nats.dashboard.refreshInterval` | `2000` | Server, stream and cluster dashboard polling interval in milliseconds. |
| `nats.request.timeout` | `5000` | Default request/reply timeout in milliseconds. |
| `nats.confirmDestructiveActions` | `true` | Ask for confirmation before deleting or purging streams, consumers, buckets, keys and objects. |
| `nats.objectStore.maxPreviewBytes` | `5242880` | Objects larger than this many bytes are not opened in an editor (download them instead). |
| `nats.contexts.autoDiscover` | `true` | Show NATS CLI contexts (nats context ls) in the explorer automatically and keep them in sync with the context files. |
| `nats.contexts.directory` | `""` | NATS CLI context directory. Empty = $XDG_CONFIG_HOME/nats/context or ~/.config/nats/context. |
| `nats.connections` | `[]` | Connections shared with your team through workspace settings (no secrets — passwords, tokens and seeds are prompted once and stored in the OS keychain). Each entry: `name`, `servers`, optional `auth` (`kind`: none \| userpass \| token \| creds \| nkey, `username`, `credsFile`, `nkeyFile`), `tls`, `monitorUrl`, `environment` (dev \| test \| staging \| prod), `readOnly`. |
| `nats.connections.fromEnvironment` | `true` | Offer a connection built from NATS_URL / NATS_USER / NATS_PASSWORD / NATS_CREDS / NATS_NKEY when NATS_URL is set. |
| `nats.connections.restoreOnStartup` | `false` | Reconnect the connections that were open when VS Code was closed. |
| `nats.explorer.autoRefresh` | `true` | Refresh the explorer when JetStream advisories report created, updated or deleted streams and consumers. |
| `nats.explorer.statsRefreshInterval` | `0` | Refresh stream and consumer statistics in the explorer every N seconds (0 = off). |
| `nats.explorer.maxSubjects` | `2000` | Maximum number of subjects listed under a stream's Subjects node and in the stream dashboard. |
| `nats.health.autoRun` | `true` | Run a health check automatically after connecting. |
| `nats.health.intervalMinutes` | `0` | Re-run health checks every N minutes for live connections (0 = off). |
| `nats.health.pendingWarning` | `10000` | Warn when a consumer has more unprocessed (pending) messages than this. |
| `nats.health.ackPendingRatio` | `0.9` | Warn when a consumer's ack pending count reaches this fraction of max_ack_pending. |
| `nats.health.storageWarningRatio` | `0.8` | Warn when a stream or account uses this fraction of its storage / message limits. |
| `nats.health.storageErrorRatio` | `0.95` | Report an error at this fraction of a storage / message limit. |
| `nats.health.rttWarningMs` | `100` | Warn when the client ↔ server round-trip time exceeds this many milliseconds. |
| `nats.overview.refreshInterval` | `3000` | Refresh interval (ms) of the Overview sidebar and Home dashboard. |

## Commands

All commands are in the Command Palette under **NATS:**. Most are also in the context menus of the NATS view.

| Command | ID |
| --- | --- |
| Add Connection | `nats.addConnection` |
| Copy NATS CLI Contexts into VS Code… | `nats.importContexts` |
| Remove Connection | `nats.removeConnection` |
| Connect | `nats.connect` |
| Disconnect | `nats.disconnect` |
| Select Active Connection | `nats.selectActiveConnection` |
| Refresh | `nats.refresh` |
| Open Server Dashboard | `nats.openDashboard` |
| Show Server Info (JSON) | `nats.serverInfo` |
| Create Stream… | `nats.createStream` |
| Browse Messages | `nats.browseMessages` |
| Create KV Bucket… | `nats.createKvBucket` |
| Open KV Browser | `nats.openKvBrowser` |
| Create Object Store Bucket… | `nats.createObjBucket` |
| Live Tail (Subscribe)… | `nats.subscribe` |
| Publish Message… | `nats.publish` |
| Request / Reply… | `nats.request` |
| Publish Selection to Subject… | `nats.publishSelection` |
| Dead Letter Monitor | `nats.deadLetters` |
| New Playbook (.nats) | `nats.newPlaybook` |
| Set Playbook Connection | `nats.setPlaybookConnection` |
| Refresh | `nats.refreshInfoDoc` |
| Connect to Local Server (localhost:4222) | `nats.connectLocal` |
| Set Environment… | `nats.setEnvironment` |
| Toggle Read-Only Mode | `nats.toggleReadOnly` |
| Show Hidden Connections… | `nats.showHiddenConnections` |
| Open Terminal for nats CLI | `nats.openTerminal` |
| Run Health Check | `nats.runHealthCheck` |
| Open Health Dashboard | `nats.openHealthDashboard` |
| Export Health Report (Markdown) | `nats.exportHealthReport` |
| Open Stream Dashboard | `nats.openStreamDashboard` |
| Open JetStream Topology | `nats.openTopology` |
| Open Cluster Overview | `nats.openCluster` |
| Show User Info & Permissions | `nats.whoAmI` |
| Open NATS Home | `nats.openHome` |
| Export JetStream Config to Workspace… | `nats.exportConfig` |
| Apply Config to Server | `nats.applyConfigFile` |
| Compare Config with Server | `nats.compareConfigFile` |
| Plan & Apply Config Folder… | `nats.planConfigFolder` |

## Troubleshooting

| Symptom | What to check |
| --- | --- |
| "No NATS connections yet" although you have contexts | Is `nats.contexts.autoDiscover` on? Is `nats.contexts.directory` right? Is the context hidden (**Show Hidden Connections**) or shadowed by a saved connection with the same name? |
| Dashboards say *monitoring unreachable* | Start the server with `-m 8222`, or set the monitoring URL in the connection editor. |
| Permission errors in some views | Restricted users may lack JetStream API or `$SYS` permissions. Views degrade gracefully, and the Message Browser falls back to direct gets. |
| A write is refused with *read-only* | The connection is in read-only mode (lock icon). Toggle it from the connection's context menu. |
| Cluster view shows only one server | The full view needs system-account credentials; without them it uses the connected server's monitoring endpoint. |
| Logs | **Output → NATS** (set the log level to *Debug* for RPC details). |
