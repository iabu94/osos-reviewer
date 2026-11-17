# PostgreSQL Standards

## Schema changes

Apply schema changes through versioned migrations. Migrations must be safe to run once in deployment order.

## Indexes

Add indexes for measured query patterns and document the workload that justifies each non-obvious index.
