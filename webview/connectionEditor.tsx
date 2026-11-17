import "./lib/styles.css";
import { render } from "preact";
import { useEffect, useState } from "preact/hooks";
import { getInit, rpc } from "./lib/vscode";
import { Button, ErrorBanner, Field, Icon, Notice, Select } from "./lib/ui";
import type { AuthKind, ConnectionProfile, ProfileSecrets } from "../src/core/profile";
import type { EditorInit } from "../src/panels/connectionEditorPanel";

const init = getInit<EditorInit>();

type Profile = EditorInit["profile"];

function FileInput({ value, onChange, placeholder, title, filters }: { value?: string; onChange: (v: string) => void; placeholder?: string; title: string; filters?: Record<string, string[]> }) {
  return (
    <div class="row">
      <input class="input grow mono" value={value ?? ""} placeholder={placeholder} onInput={(e) => onChange((e.target as HTMLInputElement).value)} />
      <Button
        icon="folder-opened"
        title="Browse…"
        onClick={() =>
          void rpc<string | null>("browse", { title, filters }).then((p) => {
            if (p) onChange(p);
          })
        }
      />
    </div>
  );
}

function SecretInput({ value, stored, onChange, placeholder }: { value: string; stored: boolean; onChange: (v: string) => void; placeholder?: string }) {
  const [show, setShow] = useState(false);
  const common = {
    class: "input grow",
    value,
    autocomplete: "off",
    placeholder: stored ? "•••••••• (stored in keychain — type to replace)" : placeholder,
    onInput: (e: Event) => onChange((e.target as HTMLInputElement).value),
  };
  return (
    <div class="row">
      {show ? <input type="text" {...common} /> : <input type="password" {...common} />}
      <Button icon={show ? "eye-closed" : "eye"} title={show ? "Hide" : "Show"} onClick={() => setShow(!show)} />
    </div>
  );
}

interface TestResult {
  server: string;
  url: string;
  rtt: string;
  connectMs: number;
  jetstream: string;
  monitor: string;
  tls: string;
}

function App() {
  const [p, setP] = useState<Profile>(() => JSON.parse(JSON.stringify(init.profile)) as Profile);
  const [servers, setServers] = useState(init.profile.servers.join(", "));
  const [secrets, setSecrets] = useState<Required<ProfileSecrets>>({ password: "", token: "", nkeySeed: "" });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<"test" | "save" | null>(null);
  const [test, setTest] = useState<TestResult | null>(null);
  const [derived, setDerived] = useState("");
  const [advanced, setAdvanced] = useState(Boolean(p.jsDomain || p.jsApiPrefix || p.inboxPrefix || p.connectTimeoutMs || p.noEcho || p.maxReconnectAttempts !== undefined));

  useEffect(() => {
    const t = setTimeout(() => void rpc<string>("deriveMonitor", { servers }).then(setDerived), 200);
    return () => clearTimeout(t);
  }, [servers]);

  const set = <K extends keyof Profile>(k: K, v: Profile[K]) => setP((prev) => ({ ...prev, [k]: v }));
  const setAuth = (patch: Partial<Profile["auth"]>) => setP((prev) => ({ ...prev, auth: { ...prev.auth, ...patch } }));
  const tls = p.tls ?? { enabled: false };
  const setTls = (patch: Partial<NonNullable<Profile["tls"]>>) => setP((prev) => ({ ...prev, tls: { ...(prev.tls ?? { enabled: false }), ...patch } }));
  const num = (s: string) => (s.trim() === "" ? undefined : Number(s));

  const form = () => ({
    profile: { ...p, servers: servers.split(/[,\s]+/).filter(Boolean) } as Omit<ConnectionProfile, "id"> & { id?: string },
    secrets: {
      password: secrets.password || undefined,
      token: secrets.token || undefined,
      nkeySeed: secrets.nkeySeed || undefined,
    },
  });

  const run = async (kind: "test" | "save", connectAfter = false) => {
    setBusy(kind);
    setError(null);
    if (kind === "test") setTest(null);
    try {
      if (kind === "test") setTest(await rpc<TestResult>("test", form()));
      else await rpc("save", { form: form(), connectAfter });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const kind = p.auth.kind;
  return (
    <div class="scroll grow">
      <div class="page-header">
        <div class="title">
          <Icon name="plug" />
          <h2>{init.isNew ? "New NATS connection" : `Edit connection — ${init.profile.name}`}</h2>
        </div>
      </div>
      <form
        class="col pad"
        style={{ maxWidth: "760px" }}
        onSubmit={(e) => {
          e.preventDefault();
          void run("save", init.isNew);
        }}
      >
        <div class="grid-2">
          <Field label="Name">
            <input class="input" value={p.name} required onInput={(e) => set("name", (e.target as HTMLInputElement).value)} />
          </Field>
          <Field label="Servers" hint="Comma separated, e.g. nats://host:4222, tls://host2:4222 or ws://host:8080">
            <input class="input mono" value={servers} required onInput={(e) => setServers((e.target as HTMLInputElement).value)} />
          </Field>
        </div>

        <h3 style={{ marginTop: "8px" }}>Authentication</h3>
        <div class="grid-2">
          <Field label="Method">
            <Select<AuthKind>
              value={kind}
              onChange={(v) => setAuth({ kind: v })}
              options={[
                { value: "none", label: "None" },
                { value: "userpass", label: "Username / password" },
                { value: "token", label: "Token" },
                { value: "creds", label: "Credentials file (.creds — JWT + NKey)" },
                { value: "nkey", label: "NKey seed" },
              ]}
            />
          </Field>
          {kind === "userpass" && (
            <Field label="Username">
              <input class="input" value={p.auth.username ?? ""} onInput={(e) => setAuth({ username: (e.target as HTMLInputElement).value })} />
            </Field>
          )}
        </div>
        {kind === "userpass" && (
          <Field label="Password">
            <SecretInput value={secrets.password} stored={init.stored.password} onChange={(v) => setSecrets({ ...secrets, password: v })} />
          </Field>
        )}
        {kind === "token" && (
          <Field label="Token">
            <SecretInput value={secrets.token} stored={init.stored.token} onChange={(v) => setSecrets({ ...secrets, token: v })} />
          </Field>
        )}
        {kind === "creds" && (
          <Field label="Credentials file" hint="Generated by nsc / Synadia Cloud. The file is read at connect time and never copied.">
            <FileInput value={p.auth.credsFile} onChange={(v) => setAuth({ credsFile: v })} placeholder="~/.nkeys/creds/…/user.creds" title="Select a .creds file" filters={{ Credentials: ["creds"], All: ["*"] }} />
          </Field>
        )}
        {kind === "nkey" && (
          <div class="grid-2">
            <Field label="Seed (stored in keychain)">
              <SecretInput value={secrets.nkeySeed} stored={init.stored.nkeySeed} placeholder="SU…" onChange={(v) => setSecrets({ ...secrets, nkeySeed: v })} />
            </Field>
            <Field label="…or seed file">
              <FileInput value={p.auth.nkeyFile} onChange={(v) => setAuth({ nkeyFile: v })} placeholder="~/.nkeys/user.nk" title="Select an NKey seed file" />
            </Field>
          </div>
        )}

        <h3 style={{ marginTop: "8px" }}>TLS</h3>
        <label class="check">
          <input type="checkbox" checked={tls.enabled} onChange={(e) => setTls({ enabled: (e.target as HTMLInputElement).checked })} /> Use TLS options (CA / client certificate)
        </label>
        {tls.enabled && (
          <>
            <div class="grid-3">
              <Field label="CA certificate">
                <FileInput value={tls.caFile} onChange={(v) => setTls({ caFile: v })} title="CA certificate" filters={{ PEM: ["pem", "crt", "cer"], All: ["*"] }} />
              </Field>
              <Field label="Client certificate">
                <FileInput value={tls.certFile} onChange={(v) => setTls({ certFile: v })} title="Client certificate" filters={{ PEM: ["pem", "crt", "cer"], All: ["*"] }} />
              </Field>
              <Field label="Client key">
                <FileInput value={tls.keyFile} onChange={(v) => setTls({ keyFile: v })} title="Client key" filters={{ PEM: ["pem", "key"], All: ["*"] }} />
              </Field>
            </div>
            <div class="row wrap">
              <Field label="Server name (SNI)" class="grow">
                <input class="input" value={tls.serverName ?? ""} onInput={(e) => setTls({ serverName: (e.target as HTMLInputElement).value || undefined })} />
              </Field>
              <label class="check">
                <input type="checkbox" checked={Boolean(tls.handshakeFirst)} onChange={(e) => setTls({ handshakeFirst: (e.target as HTMLInputElement).checked || undefined })} /> TLS handshake first
              </label>
              <label class="check" title="Disables certificate verification — only for development">
                <input type="checkbox" checked={Boolean(tls.insecureSkipVerify)} onChange={(e) => setTls({ insecureSkipVerify: (e.target as HTMLInputElement).checked || undefined })} /> Skip verification (insecure)
              </label>
            </div>
          </>
        )}

        <h3 style={{ marginTop: "8px" }}>Monitoring</h3>
        <Field label="HTTP monitoring URL" hint={derived ? `Leave empty to use ${derived} (nats-server -m 8222)` : "Used by the dashboard (varz / connz / jsz)"}>
          <input class="input mono" value={p.monitorUrl ?? ""} placeholder={derived} onInput={(e) => set("monitorUrl", (e.target as HTMLInputElement).value || undefined)} />
        </Field>

        <h3 style={{ marginTop: "8px" }}>Environment &amp; safety</h3>
        <div class="row wrap" style={{ alignItems: "flex-end", gap: "16px" }}>
          <Field label="Environment" hint="Shown as a colour in the tree, status bar and dashboards">
            <Select<string>
              value={p.environment ?? ""}
              onChange={(v) => set("environment", (v || undefined) as Profile["environment"])}
              options={[
                { value: "", label: "None" },
                { value: "dev", label: "Development" },
                { value: "test", label: "Test" },
                { value: "staging", label: "Staging" },
                { value: "prod", label: "Production" },
              ]}
            />
          </Field>
          <label class="check" title="Blocks publishing, KV / stream / consumer / object changes, purges and acks">
            <input type="checkbox" checked={Boolean(p.readOnly)} onChange={(e) => set("readOnly", (e.target as HTMLInputElement).checked || undefined)} /> Read-only
          </label>
          <label class="check">
            <input type="checkbox" checked={Boolean(p.autoConnect)} onChange={(e) => set("autoConnect", (e.target as HTMLInputElement).checked || undefined)} /> Connect when VS Code starts
          </label>
        </div>
        {p.environment === "prod" && (
          <Notice tone="warn">Production: destructive actions require typing the resource name, and confirmations can't be turned off.{p.readOnly ? "" : " Consider enabling read-only."}</Notice>
        )}

        <button type="button" class="btn btn-ghost" style={{ alignSelf: "flex-start" }} onClick={() => setAdvanced(!advanced)}>
          <Icon name={advanced ? "chevron-down" : "chevron-right"} /> <span>Advanced</span>
        </button>
        {advanced && (
          <>
            <div class="grid-3">
              <Field label="JetStream domain">
                <input class="input" value={p.jsDomain ?? ""} onInput={(e) => set("jsDomain", (e.target as HTMLInputElement).value || undefined)} />
              </Field>
              <Field label="JetStream API prefix">
                <input class="input" value={p.jsApiPrefix ?? ""} placeholder="$JS.API" onInput={(e) => set("jsApiPrefix", (e.target as HTMLInputElement).value || undefined)} />
              </Field>
              <Field label="Inbox prefix">
                <input class="input" value={p.inboxPrefix ?? ""} placeholder="_INBOX" onInput={(e) => set("inboxPrefix", (e.target as HTMLInputElement).value || undefined)} />
              </Field>
              <Field label="Connect timeout (ms)">
                <input class="input" type="number" min="100" value={p.connectTimeoutMs ?? ""} placeholder="5000" onInput={(e) => set("connectTimeoutMs", num((e.target as HTMLInputElement).value))} />
              </Field>
              <Field label="Max reconnect attempts" hint="-1 = forever">
                <input class="input" type="number" min="-1" value={p.maxReconnectAttempts ?? ""} placeholder="-1" onInput={(e) => set("maxReconnectAttempts", num((e.target as HTMLInputElement).value))} />
              </Field>
              <Field label="Reconnect wait (ms)">
                <input class="input" type="number" min="0" value={p.reconnectTimeWaitMs ?? ""} placeholder="2000" onInput={(e) => set("reconnectTimeWaitMs", num((e.target as HTMLInputElement).value))} />
              </Field>
            </div>
            <label class="check">
              <input type="checkbox" checked={Boolean(p.noEcho)} onChange={(e) => set("noEcho", (e.target as HTMLInputElement).checked || undefined)} /> No echo (don't receive own publishes)
            </label>
          </>
        )}

        <ErrorBanner error={error} onDismiss={() => setError(null)} />
        {test && (
          <Notice tone="ok">
            Connected to <b>{test.server}</b> at {test.url} in {test.connectMs} ms · RTT {test.rtt} · TLS {test.tls}
            <br />
            JetStream: {test.jetstream} · Monitoring: {test.monitor}
          </Notice>
        )}

        <div class="row" style={{ marginTop: "6px" }}>
          <Button variant="primary" icon="save" busy={busy === "save"} onClick={() => void run("save", init.isNew)}>
            {init.isNew ? "Save & Connect" : "Save"}
          </Button>
          {init.isNew && (
            <Button icon="save" disabled={busy !== null} onClick={() => void run("save", false)}>
              Save
            </Button>
          )}
          <Button icon="debug-start" busy={busy === "test"} onClick={() => void run("test")}>
            Test Connection
          </Button>
          <div class="spacer" />
          <Button variant="ghost" onClick={() => void rpc("cancel")}>
            Cancel
          </Button>
        </div>
        <p class="muted small">Passwords, tokens and seeds are stored with VS Code SecretStorage (your OS keychain), never in settings.</p>
      </form>
    </div>
  );
}

render(<App />, document.getElementById("root")!);
