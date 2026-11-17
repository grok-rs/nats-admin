// Detects a NATS server by reading its INFO greeting (pure; unit tested).

import { Socket } from "node:net";

/** True when something speaking the NATS protocol answers on host:port. */
export function probeNats(host = "127.0.0.1", port = 4222, timeoutMs = 600): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = new Socket();
    let done = false;
    const finish = (v: boolean) => {
      if (done) return;
      done = true;
      sock.destroy();
      resolve(v);
    };
    sock.setTimeout(timeoutMs, () => finish(false));
    sock.once("error", () => finish(false));
    sock.once("data", (d) => finish(d.toString("utf8", 0, 5) === "INFO "));
    sock.connect(port, host);
  });
}
