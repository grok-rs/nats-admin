// Shared "NATS" log output channel. Falls back to console outside VS Code (tests).

interface Logger {
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
  debug(msg: string): void;
}

let impl: Logger = {
  info: (m) => console.log(m),
  warn: (m) => console.warn(m),
  error: (m) => console.error(m),
  debug: () => undefined,
};

export const log: Logger = {
  info: (m) => impl.info(m),
  warn: (m) => impl.warn(m),
  error: (m) => impl.error(m),
  debug: (m) => impl.debug(m),
};

export function setLogger(l: Logger): void {
  impl = l;
}
