/** Thrown by scaffolded-but-unimplemented code; the message names the milestone. */
export class NotImplementedError extends Error {
  constructor(what: string) {
    super(`Not implemented yet: ${what}`);
    this.name = "NotImplementedError";
  }
}

export class ReviewError extends Error {
  readonly kind: string;
  readonly retriable: boolean;
  constructor(kind: string, message: string, retriable = false) {
    super(message);
    this.name = "ReviewError";
    this.kind = kind;
    this.retriable = retriable;
  }
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}
