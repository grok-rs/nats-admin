window.__MOCK_INIT__ = { profile: { name: "local", servers: ["nats://127.0.0.1:4333"], auth: { kind: "userpass", username: "admin" } }, stored: { password: true, token: false, nkeySeed: false }, isNew: false };
window.__MOCK__ = {
  deriveMonitor: ({ servers }) => "http://127.0.0.1:8222",
  browse: () => "/home/user/.nkeys/user.creds",
  test: () => new Promise((r) => setTimeout(() => r({ server: "dev-local (NCM7V2C5…) v2.14.4", url: "127.0.0.1:4333", rtt: "0.21 ms", connectMs: 4, jetstream: "enabled · 3 streams · 2 consumers", monitor: "reachable at http://127.0.0.1:8333", tls: "off" }), 300)),
  save: () => true,
  cancel: () => true,
};
