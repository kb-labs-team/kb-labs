# ADR-0055: Single resolved catalog

Status: Accepted

## Decision

The catalog is the single interpreter of marketplace locks, manifests, and configuration declarations. It produces a resolved view of plugins, adapters, workflows, and entities. Marketplace writes the marketplace lock; config operations write the user configuration layer; the project registry writes project state; services write their own declarations. Files remain the source of truth and the catalog is a derived projection.

The resolved generation is identified by the existing snapshot `rev` and `checksum`. Today, an in-process library implements the read contract. Later, the host may own a catalog service behind the same contract over `IServiceTransport`. Cloud pods can subscribe to generations and apply a new generation only when no work is in flight, following the restart refusal rule.

Service capabilities from S-045 may become a catalog entity kind later. They are not part of this change.

## Consequences

Readers depend on the catalog contract and receive one resolved reader from their process composition root. Marketplace remains the lock writer and may use discovery's lock-writing operations. Adapter declarations are catalog entries; adapter module loading remains in core runtime.
