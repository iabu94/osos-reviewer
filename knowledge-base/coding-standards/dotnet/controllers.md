# .NET Controllers

## Data access

Controllers must not access DbContext directly. Delegate persistence and queries to application services or repositories.

## HTTP behavior

Controllers should validate transport concerns, return explicit status codes, and keep business rules outside actions.
