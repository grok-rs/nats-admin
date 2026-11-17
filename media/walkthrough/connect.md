## Connect to NATS

NATS Admin finds connections on its own — no import step:

- **NATS CLI contexts** from `~/.config/nats/context` (the one picked with `nats context select` gets a ★). They stay in sync with the files.
- **`NATS_URL`** (plus `NATS_USER`, `NATS_PASSWORD`, `NATS_CREDS`, `NATS_NKEY`) from the environment VS Code was started with.
- **Team connections** from the `nats.connections` workspace setting. Commit them without secrets: passwords are asked for once and kept in your OS keychain.
- A **local server** on `localhost:4222` is detected and offered with one click.

Or add a connection by hand. The editor supports user/password, token, `.creds`, NKey, TLS/mTLS, and has a *Test Connection* button.
