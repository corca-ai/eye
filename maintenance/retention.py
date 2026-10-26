"""Remove expired Eye rows through Iceberg transactions, never by deleting R2 files."""
import argparse
import json
import os
import re
import time

from pyiceberg.catalog.rest import RestCatalog
from pyiceberg.exceptions import CommitFailedException, NoSuchTableError
from pyiceberg.expressions import And, EqualTo, LessThan, NotEqualTo, Or
from pyiceberg.types import LongType, StringType

TABLES = ("events", "projections")
RETENTION_MS = 60 * 86_400_000


def validate_eye_table(table):
    """Refuse a namespace accidentally pointing at unrelated business tables."""
    expected = {"occurred_at": LongType(), "received_at": LongType(), "schema_version": LongType(),
                "site_id": StringType(), "table_name": StringType(), "record_id": StringType()}
    for name, field_type in expected.items():
        if table.schema().find_field(name).field_type != field_type:
            raise ValueError("Not an Eye analytics schema")


def expire_rows(catalog, namespace, cutoff, apply=False):
    """One fixed cutoff per invocation; whole matching files use metadata-only delete.

    Partial boundary files use PyIceberg copy-on-write. Conflicting commits reload
    table metadata; an unknown commit result is left for the next scheduled pass.
    """
    results = []
    for name in TABLES:
        # Dictionaries are keyed by UTC day; retain the live boundary day.
        dictionary_cutoff = cutoff // 86_400_000 * 86_400_000
        predicate = Or(And(EqualTo("table_name", "attribute_keys"), LessThan("occurred_at", dictionary_cutoff)),
                       And(NotEqualTo("table_name", "attribute_keys"), LessThan("occurred_at", cutoff)))
        for attempt in range(3):
            try:
                table = catalog.load_table((namespace, name))
                validate_eye_table(table)
                if apply:
                    table.delete(predicate)
                results.append({"table": name, "status": "expired" if apply else "validated", "cutoff": cutoff, "dictionary_cutoff": dictionary_cutoff})
                break
            except NoSuchTableError:
                results.append({"table": name, "status": "not_created"})
                break
            except CommitFailedException:
                if attempt == 2:
                    raise
    return results


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--warehouse", required=True, help="Account ID followed by underscore and bucket name")
    parser.add_argument("--namespace", default="eye")
    parser.add_argument("--apply", action="store_true", help="Commit 60-day row expiration; otherwise validate only")
    args = parser.parse_args()
    match = re.fullmatch(r"([a-fA-F0-9]{32})_([a-z0-9][a-z0-9-]{1,61}[a-z0-9])", args.warehouse)
    if not match or not re.fullmatch(r"[a-zA-Z_][a-zA-Z0-9_]{0,62}", args.namespace):
        parser.error("Invalid warehouse or namespace")
    token = os.environ.get("EYE_CATALOG_TOKEN")
    if not token:
        parser.error("EYE_CATALOG_TOKEN is required")
    account, bucket = match.groups()
    catalog = RestCatalog("eye", uri=f"https://catalog.cloudflarestorage.com/{account}/{bucket}",
                          warehouse=args.warehouse, token=token)
    cutoff = time.time_ns() // 1_000_000 - RETENTION_MS
    print(json.dumps(expire_rows(catalog, args.namespace, cutoff, args.apply)))


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        # SDK/HTTP exceptions may contain credentials or signed object URLs.
        print(json.dumps({"status": "failed", "error_type": type(error).__name__}))
        raise SystemExit(1)
