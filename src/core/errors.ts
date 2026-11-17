// Shared error types (kept dependency-free to avoid import cycles).

/** Thrown when the user dismisses a prompt; command wrappers ignore it silently. */
export class CancelledError extends Error {
  constructor() {
    super("cancelled");
    this.name = "CancelledError";
  }
}
