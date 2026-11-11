# @kb-labs/adapters-sqlite

The SQLite adapter package provides local implementations of
`IDocumentDatabase`, `IKVStore`, and `IVectorStore` using the bundled
`better-sqlite3` driver. No external database service is required.

## Built-in vector store

Fresh installs select `@kb-labs/adapters-sqlite/vector-store` as the
`vectorStore` default. It writes to
`<KB_HOME>/state/<projectId>/vector-store/vectors.sqlite`. The runtime resolves
the project ID through the project registry, so the file remains available to
that project after a host restart and stays outside the repository. No adapter
binding or path configuration is needed.

Search uses brute-force cosine similarity within the selected namespace. Each
search reads the namespace's records and computes scores in process, so work
and memory grow linearly with the number and dimension of stored vectors. This
is intended for small local indexes, not large or latency-sensitive workloads.
Every stored or searched vector must contain finite, non-zero values, cannot be
empty, and must have the same dimension as every other vector in its namespace.
Invalid inputs return the catalogued `KB_RUNTIME_INPUT_INVALID` error for the
`vector` field before a write or ranking result is produced.
It has no approximate-nearest-neighbor index or native SQLite extension.
Choose a dedicated vector database such as Qdrant when an index outgrows those
limits.

The adapter preserves caller IDs, vectors, metadata, and namespaces across
host restarts. Replacing the adapter does not migrate or delete its SQLite data.

## Other SQLite stores

The package root provides `IDocumentDatabase`, and
`@kb-labs/adapters-sqlite/kv` provides `IKVStore`. Both use the
`filename` option and can share one SQLite file. The vector store has its own
`vectorFilename` option and database file.

All three slots are available as built-in local defaults. Their paths resolve
beneath the platform data root unless the user supplies an absolute path.
