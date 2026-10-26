import tempfile
import unittest

import pyarrow as pa
from pyiceberg.catalog import load_catalog
from pyiceberg.transforms import BucketTransform

from retention import expire_rows


class RetentionTests(unittest.TestCase):
    def test_expiration_preserves_boundary_and_new_rows_across_sites_and_repeats(self):
        for partitioned in (False, True):
            with self.subTest(partitioned=partitioned):
                with tempfile.TemporaryDirectory() as folder:
                    catalog = load_catalog("test", type="sql", uri=f"sqlite:///{folder}/catalog.db", warehouse=f"file://{folder}")
                    catalog.create_namespace("eye")
                    schema = pa.schema([(name, pa.int64() if name in ("occurred_at", "received_at", "schema_version") else pa.string())
                                        for name in ("occurred_at", "received_at", "schema_version", "site_id", "table_name", "record_id")])
                    table = catalog.create_table(("eye", "events"), schema=schema)
                    if partitioned:
                        with table.update_spec() as update:
                            update.add_field("site_id", BucketTransform(4))
                    def rows(times):
                        return pa.Table.from_pylist([dict(occurred_at=at, received_at=at, schema_version=1,
                            site_id="a" if at % 2 else "b", table_name="events", record_id=str(at)) for at in times], schema=schema)
                    table.append(rows([1, 2]))  # Entire old file can be removed through metadata.
                    table.append(rows([3, 4, 5]))  # A boundary file must be rewritten.
                    self.assertEqual(expire_rows(catalog, "eye", 4)[0]["status"], "validated")
                    self.assertEqual(len(table.refresh().scan().to_arrow()), 5)
                    for _ in range(2):
                        expire_rows(catalog, "eye", 4, apply=True)
                        self.assertEqual(sorted(table.refresh().scan().to_arrow()["occurred_at"].to_pylist()), [4, 5])
                    self.assertEqual(expire_rows(catalog, "eye", 4)[1]["status"], "not_created")

    def test_daily_dictionary_keeps_the_partially_live_cutoff_day(self):
        with tempfile.TemporaryDirectory() as folder:
            catalog = load_catalog("test", type="sql", uri=f"sqlite:///{folder}/catalog.db", warehouse=f"file://{folder}")
            catalog.create_namespace("eye")
            schema = pa.schema([(name, pa.int64() if name in ("occurred_at", "received_at", "schema_version") else pa.string())
                                for name in ("occurred_at", "received_at", "schema_version", "site_id", "table_name", "record_id")])
            day = 86_400_000
            table = catalog.create_table(("eye", "projections"), schema=schema)
            for name in ("observations", "attribute_keys"):
                times = [day - 1, day + 11] if name == "observations" else [0, day]
                table.append(pa.Table.from_pylist([dict(occurred_at=at, received_at=at, schema_version=1,
                    site_id="site", table_name=name, record_id=str(at)) for at in times], schema=schema))
            expire_rows(catalog, "eye", day + 10, apply=True)
            self.assertEqual(sorted(catalog.load_table(("eye", "projections")).scan().to_arrow()["occurred_at"].to_pylist()), [day, day + 11])

    def test_wrong_schema_is_refused_before_deletion(self):
        with tempfile.TemporaryDirectory() as folder:
            catalog = load_catalog("test", type="sql", uri=f"sqlite:///{folder}/catalog.db", warehouse=f"file://{folder}")
            catalog.create_namespace("eye")
            table = catalog.create_table(("eye", "events"), schema=pa.schema([("name", pa.string())]))
            table.append(pa.table({"name": ["keep"]}))
            with self.assertRaises(ValueError):
                expire_rows(catalog, "eye", 4, apply=True)
            self.assertEqual(len(table.refresh().scan().to_arrow()), 1)


if __name__ == "__main__":
    unittest.main()
