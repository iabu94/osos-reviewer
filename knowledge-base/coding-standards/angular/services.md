# Angular Services

## Dependency injection

Use `providedIn: "root"` for stateless application-wide services. Depend on abstractions at integration boundaries.

## Observables

Services should expose observables without subscribing internally unless they own the full lifecycle.
