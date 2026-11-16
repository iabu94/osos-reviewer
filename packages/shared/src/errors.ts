export class ConfigError extends Error {
  readonly code = "config_error";
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

export class TicketUnresolvedError extends Error {
  readonly code = "ticket_unresolved";
  constructor(message = "Ticket identifier could not be resolved") {
    super(message);
    this.name = "TicketUnresolvedError";
  }
}

export class UnknownRepositoryError extends Error {
  readonly code = "unknown_repository";
  constructor(message: string) {
    super(message);
    this.name = "UnknownRepositoryError";
  }
}
