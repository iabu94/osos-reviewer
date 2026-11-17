# Integration Guidelines

## Contracts

Integrations must validate external payloads at the boundary and convert them into internal typed values.

## Resilience

Set bounded timeouts for network calls and surface provider failures with enough context for diagnosis.
