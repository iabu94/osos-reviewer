# .NET Repositories

## Query boundaries

Repositories should encapsulate persistence queries and return domain-oriented results rather than leaking `IQueryable`.

## Cancellation

Async repository operations must accept and propagate a `CancellationToken`.
