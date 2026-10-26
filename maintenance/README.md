# Catalog row retention

The TypeScript query horizon does not delete stored rows. Run this maintenance
outside the Worker, using the pinned Python environment:

```sh
uv run --locked --project maintenance python maintenance/retention.py \
  --warehouse ACCOUNT_ID_BUCKET --namespace eye
```

The default validates the existing Eye schemas without writing. Add `--apply`
to remove rows whose occurrence time is earlier than the current time minus
60 days. One cutoff is fixed for the entire invocation. The identifier-free
`attribute_keys` dictionary uses UTC-day buckets, so its cutoff is rounded down
to preserve the partially live boundary day required by attribute discovery. Run at least daily from
a scheduler with failure alerts. For an installed SDK, replace both maintenance
paths with `node_modules/@eye/workers/maintenance`.

`EYE_CATALOG_TOKEN` must be provided through the runner's secret store with
Catalog read/write and R2 object read/write access to the selected bucket.
Warehouse and namespace are explicit; no other namespace or bucket is visited.
Missing tables are reported as `not_created` because a new Stream has not
necessarily written every table yet. Existing tables must have the Eye schema.
Errors expose only exception types, never token values or signed object URLs.

Deletion commits through PyIceberg's Catalog transaction. Whole matching files
can be excluded through metadata; only boundary files require copy-on-write.
Concurrent commit conflicts reload metadata and retry at most three times.
The next scheduled pass can repeat safely after an unknown commit outcome.
The script neither drops tables nor deletes R2 objects directly. The locked
`pyiceberg-core` extra supplies native partition transforms required when
rewriting partitioned Catalog data files; unpartitioned local fixtures alone
do not exercise that dependency.

**Physical cleanup is a separate step.** Enable Catalog automatic snapshot
expiration and compaction on this bucket during provisioning. Row deletion
creates a new snapshot; old snapshots still reference the removed data until
expiration runs. `--older-than-days 1 --retain-last 1` permits old snapshots to
expire after a day while retaining the current snapshot. Actual file reclamation
is eventual and must be verified from Catalog maintenance runs; a successful
row deletion does not prove that old files have been removed. Never use an R2
lifecycle rule to delete active Iceberg data files.

Local contract tests use an actual PyIceberg SQL Catalog and Parquet files:

```sh
uv run --locked --project maintenance python -m unittest discover -s maintenance
```

They prove boundary semantics, repeatability, schema refusal, and bucket-partitioned
boundary rewrites. They do not
prove remote permissions, Stream concurrency, or Catalog physical cleanup.
