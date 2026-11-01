use std::{
    collections::{
        BTreeMap,
        HashMap,
    },
    sync::atomic::{
        AtomicUsize,
        Ordering,
    },
    time::Duration,
};

use async_trait::async_trait;
use common::shapes::reduced::{
    ReducedField,
    ReducedShape,
};
use iceberg::{
    Namespace,
    TableCommit,
};
use tokio::sync::{
    Notify,
    Semaphore,
};

use super::{
    super::tests::{
        change,
        memory_catalog,
        read,
    },
    *,
};

fn source(table: &str) -> SourceTable {
    component_source("", table)
}

fn component_source(component: &str, table: &str) -> SourceTable {
    SourceTable {
        component: component.to_owned(),
        table: table.to_owned(),
    }
}

async fn open(catalog: Arc<dyn Catalog>) -> Result<IcebergChangeWriter> {
    open_selecting(catalog, vec![]).await
}

async fn open_selecting(
    catalog: Arc<dyn Catalog>,
    selected: Vec<SourceTable>,
) -> Result<IcebergChangeWriter> {
    IcebergChangeWriter::open(
        catalog,
        "convex_chess_wandering_fish_513",
        "memory://warehouse",
        selected,
        Format::Typed,
    )
    .await
}

async fn changes(writer: &IcebergChangeWriter, table: &str) -> Result<Vec<Change>> {
    let ident = TableIdent::new(
        writer.namespace.clone(),
        IcebergChangeWriter::table_name(&source(table))?,
    );
    read(&writer.catalog.load_table(&ident).await?).await
}

#[derive(Debug)]
struct BlockingCatalog {
    inner: Arc<dyn Catalog>,
    active_loads: AtomicUsize,
    max_active_loads: AtomicUsize,
    started: Notify,
    gate: Semaphore,
    fail_table: Option<String>,
}

impl BlockingCatalog {
    fn new(inner: Arc<dyn Catalog>, fail_table: Option<String>) -> Self {
        Self {
            inner,
            active_loads: AtomicUsize::new(0),
            max_active_loads: AtomicUsize::new(0),
            started: Notify::new(),
            gate: Semaphore::new(0),
            fail_table,
        }
    }
}

struct ActiveLoad<'a>(&'a AtomicUsize);

impl Drop for ActiveLoad<'_> {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::SeqCst);
    }
}

#[async_trait]
impl Catalog for BlockingCatalog {
    async fn list_namespaces(
        &self,
        parent: Option<&NamespaceIdent>,
    ) -> iceberg::Result<Vec<NamespaceIdent>> {
        self.inner.list_namespaces(parent).await
    }

    async fn create_namespace(
        &self,
        namespace: &NamespaceIdent,
        properties: HashMap<String, String>,
    ) -> iceberg::Result<Namespace> {
        self.inner.create_namespace(namespace, properties).await
    }

    async fn get_namespace(&self, namespace: &NamespaceIdent) -> iceberg::Result<Namespace> {
        self.inner.get_namespace(namespace).await
    }

    async fn namespace_exists(&self, namespace: &NamespaceIdent) -> iceberg::Result<bool> {
        self.inner.namespace_exists(namespace).await
    }

    async fn update_namespace(
        &self,
        namespace: &NamespaceIdent,
        properties: HashMap<String, String>,
    ) -> iceberg::Result<()> {
        self.inner.update_namespace(namespace, properties).await
    }

    async fn drop_namespace(&self, namespace: &NamespaceIdent) -> iceberg::Result<()> {
        self.inner.drop_namespace(namespace).await
    }

    async fn list_tables(&self, namespace: &NamespaceIdent) -> iceberg::Result<Vec<TableIdent>> {
        self.inner.list_tables(namespace).await
    }

    async fn create_table(
        &self,
        namespace: &NamespaceIdent,
        creation: TableCreation,
    ) -> iceberg::Result<Table> {
        self.inner.create_table(namespace, creation).await
    }

    async fn load_table(&self, table: &TableIdent) -> iceberg::Result<Table> {
        let active = self.active_loads.fetch_add(1, Ordering::SeqCst) + 1;
        let _active = ActiveLoad(&self.active_loads);
        self.max_active_loads.fetch_max(active, Ordering::SeqCst);
        self.started.notify_one();
        if self.fail_table.as_deref() == Some(table.name()) {
            return Err(iceberg::Error::new(
                iceberg::ErrorKind::Unexpected,
                "injected load failure",
            ));
        }
        let _permit = self.gate.acquire().await.expect("the test gate stays open");
        self.inner.load_table(table).await
    }

    async fn drop_table(&self, table: &TableIdent) -> iceberg::Result<()> {
        self.inner.drop_table(table).await
    }

    async fn purge_table(&self, table: &TableIdent) -> iceberg::Result<()> {
        self.inner.purge_table(table).await
    }

    async fn table_exists(&self, table: &TableIdent) -> iceberg::Result<bool> {
        self.inner.table_exists(table).await
    }

    async fn rename_table(&self, src: &TableIdent, dest: &TableIdent) -> iceberg::Result<()> {
        self.inner.rename_table(src, dest).await
    }

    async fn register_table(
        &self,
        table: &TableIdent,
        metadata_location: String,
    ) -> iceberg::Result<Table> {
        self.inner.register_table(table, metadata_location).await
    }

    async fn update_table(&self, commit: TableCommit) -> iceberg::Result<Table> {
        self.inner.update_table(commit).await
    }
}

#[tokio::test]
async fn table_appends_overlap_with_bounded_concurrency() -> Result<()> {
    let concurrency = *S3_EXPORT_MAX_CONCURRENT_TABLE_WRITES;
    let catalog = memory_catalog().await?;
    let sources: Vec<_> = (0..2 * concurrency + 3)
        .map(|i| source(&format!("table_{i:02}")))
        .collect();
    open(catalog.clone())
        .await?
        .apply(&sources, vec![], BTreeMap::new())
        .await?;
    let blocking = Arc::new(BlockingCatalog::new(catalog.clone(), None));
    let mut writer = open(blocking.clone()).await?;
    writer.snapshot_properties = HashMap::from([("convex.page".to_owned(), "7".to_owned())]);
    let entries = sources
        .iter()
        .flat_map(|source| {
            [
                (source.clone(), change("document", 1, Some("{}"))),
                (source.clone(), change("document", 2, None)),
            ]
        })
        .collect();
    let task = tokio::spawn(async move {
        writer.apply(&[], entries, BTreeMap::new()).await?;
        Ok::<_, anyhow::Error>(writer)
    });
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            let started = blocking.started.notified();
            if blocking.active_loads.load(Ordering::SeqCst) >= concurrency {
                break;
            }
            started.await;
        }
    })
    .await?;
    assert_eq!(
        blocking.max_active_loads.load(Ordering::SeqCst),
        concurrency
    );
    assert!(!task.is_finished());
    blocking.gate.add_permits(concurrency);
    let writer = tokio::time::timeout(Duration::from_secs(5), task).await???;
    assert_eq!(blocking.active_loads.load(Ordering::SeqCst), 0);
    assert_eq!(
        blocking.max_active_loads.load(Ordering::SeqCst),
        concurrency
    );
    assert_eq!(writer.locations().len(), sources.len());
    assert!(writer.bytes_written() > 0);
    for source in sources {
        let table = catalog
            .load_table(&TableIdent::new(
                writer.namespace.clone(),
                IcebergChangeWriter::table_name(&source)?,
            ))
            .await?;
        assert_eq!(
            read(&table).await?,
            vec![
                change("document", 1, Some("{}")),
                change("document", 2, None)
            ]
        );
        assert_eq!(
            writer.locations()[table.identifier().name()],
            table.metadata_location_result()?
        );
        assert_eq!(
            table
                .metadata()
                .current_snapshot()
                .unwrap()
                .summary()
                .additional_properties["convex.page"],
            "7"
        );
    }
    Ok(())
}

#[tokio::test]
async fn a_failed_table_cancels_pending_appends_and_preserves_locations() -> Result<()> {
    let concurrency = *S3_EXPORT_MAX_CONCURRENT_TABLE_WRITES;
    let catalog = memory_catalog().await?;
    let sources: Vec<_> = (0..concurrency)
        .map(|i| source(&format!("table_{i:02}")))
        .collect();
    let mut initial = open(catalog.clone()).await?;
    initial.apply(&sources, vec![], BTreeMap::new()).await?;
    let blocking = Arc::new(BlockingCatalog::new(
        catalog.clone(),
        Some(IcebergChangeWriter::table_name(sources.last().unwrap())?),
    ));
    let mut writer = open(blocking.clone()).await?;
    writer.locations = initial.locations().clone();
    let error = writer
        .apply(
            &[],
            sources
                .iter()
                .map(|source| (source.clone(), change("document", 1, Some("{}"))))
                .collect(),
            BTreeMap::new(),
        )
        .await
        .expect_err("one failed table must fail the page");
    assert!(
        error.to_string().contains("injected load failure"),
        "{error:#}"
    );
    assert_eq!(
        blocking.max_active_loads.load(Ordering::SeqCst),
        concurrency
    );
    assert_eq!(blocking.active_loads.load(Ordering::SeqCst), 0);
    assert_eq!(writer.locations(), initial.locations());
    assert_eq!(writer.bytes_written(), 0);
    for source in sources {
        let table = catalog
            .load_table(&TableIdent::new(
                initial.namespace.clone(),
                IcebergChangeWriter::table_name(&source)?,
            ))
            .await?;
        assert!(read(&table).await?.is_empty());
    }
    Ok(())
}

#[tokio::test]
async fn truncates_recreate_tables_and_changes_append() -> Result<()> {
    let catalog = memory_catalog().await?;
    let mut writer = open(catalog.clone()).await?;
    writer
        .apply(
            &[source("menu"), source("empty")],
            vec![(source("menu"), change("burger", 10, Some("10")))],
            BTreeMap::new(),
        )
        .await?;
    writer
        .apply(
            &[],
            vec![(source("menu"), change("burger", 12, None))],
            BTreeMap::new(),
        )
        .await?;
    assert_eq!(
        changes(&writer, "menu").await?,
        vec![change("burger", 10, Some("10")), change("burger", 12, None)]
    );
    assert!(changes(&writer, "empty").await?.is_empty());
    let properties = writer.tables[&source("menu")].metadata().properties();
    assert_eq!(properties[COMPONENT_PROPERTY], "");
    assert_eq!(properties[TABLE_PROPERTY], "menu");

    writer
        .apply(
            &[source("menu")],
            vec![(source("menu"), change("soup", 5, Some("6")))],
            BTreeMap::new(),
        )
        .await?;
    assert_eq!(
        changes(&writer, "menu").await?,
        vec![change("soup", 5, Some("6"))]
    );

    let mut reopened = open(catalog.clone()).await?;
    reopened
        .apply(
            &[],
            vec![(source("menu"), change("burger", 20, Some("12")))],
            BTreeMap::new(),
        )
        .await?;
    assert_eq!(
        changes(&reopened, "menu").await?,
        vec![
            change("burger", 20, Some("12")),
            change("soup", 5, Some("6"))
        ]
    );
    Ok(())
}

#[tokio::test]
async fn locations_track_every_commit_and_summaries_name_the_page() -> Result<()> {
    let catalog = memory_catalog().await?;
    let mut writer = open(catalog.clone()).await?;
    writer.snapshot_properties = HashMap::from([("convex.page".to_owned(), "7".to_owned())]);
    writer
        .apply(
            &[source("menu"), source("empty")],
            vec![(source("menu"), change("burger", 10, Some("10")))],
            BTreeMap::new(),
        )
        .await?;
    for name in ["app__menu", "app__empty"] {
        let table = catalog
            .load_table(&TableIdent::new(writer.namespace.clone(), name.to_owned()))
            .await?;
        assert_eq!(
            writer.locations()[name],
            table.metadata_location_result()?,
            "{name}"
        );
    }
    let menu = &writer.tables[&source("menu")];
    let snapshot = menu.metadata().current_snapshot().unwrap();
    assert_eq!(snapshot.summary().additional_properties["convex.page"], "7");
    let after_one_row = writer.bytes_written();
    assert!(after_one_row > 0, "one Parquet file was written");

    writer
        .apply(&[source("menu")], vec![], BTreeMap::new())
        .await?;
    assert_eq!(
        writer.bytes_written(),
        after_one_row,
        "recreating a table writes metadata only"
    );
    let menu = catalog
        .load_table(&TableIdent::new(
            writer.namespace.clone(),
            "app__menu".to_owned(),
        ))
        .await?;
    assert_eq!(
        writer.locations()["app__menu"],
        menu.metadata_location_result()?
    );
    Ok(())
}

#[tokio::test]
async fn names_follow_components_and_keep_case_in_directories() -> Result<()> {
    let mut writer = open(memory_catalog().await?).await?;
    let node = component_source("aggregate/inner", "btreeNode");
    writer
        .apply(
            &[source("authRefreshTokens"), node.clone()],
            vec![],
            BTreeMap::new(),
        )
        .await?;
    assert_eq!(writer.tables.len(), 2);
    for (source, name, location) in [
        (
            &node,
            "aggregate__inner__btreenode",
            "memory://warehouse/aggregate__inner/btreeNode",
        ),
        (
            &source("authRefreshTokens"),
            "app__authrefreshtokens",
            "memory://warehouse/app/authRefreshTokens",
        ),
    ] {
        let table = &writer.tables[source];
        assert_eq!(table.identifier().name(), name);
        assert_eq!(table.metadata().location(), location);
    }
    Ok(())
}

#[tokio::test]
async fn colliding_sources_fail_before_any_write() -> Result<()> {
    let mut writer = open(memory_catalog().await?).await?;
    let error = writer
        .apply(&[source("Users"), source("users")], vec![], BTreeMap::new())
        .await
        .expect_err("a colliding page must be rejected");
    assert!(error.to_string().contains("both map to"), "{error:#}");
    assert!(writer.tables.is_empty());
    writer
        .apply(&[source("menu")], vec![], BTreeMap::new())
        .await?;
    let error = open_selecting(
        writer.catalog.clone(),
        vec![source("Users"), source("users")],
    )
    .await
    .err()
    .expect("a colliding selection must be rejected");
    assert!(error.to_string().contains("both map to"), "{error:#}");
    assert_eq!(
        writer.catalog.list_tables(&writer.namespace).await?.len(),
        1
    );
    let deep = "s3://b/".to_owned() + &"p/".repeat(450);
    let error = IcebergChangeWriter::check_names(&deep, &[source("users")])
        .expect_err("an overlong location must be rejected");
    assert!(error.to_string().contains("longer than"), "{error:#}");
    Ok(())
}

#[tokio::test]
async fn a_new_table_replaces_a_leftover_with_the_same_name() -> Result<()> {
    let mut writer = open(memory_catalog().await?).await?;
    writer
        .apply(
            &[source("Users")],
            vec![(source("Users"), change("ada", 1, Some("{}")))],
            BTreeMap::new(),
        )
        .await?;
    for replacement in [source("users"), component_source("app", "users")] {
        writer = open(writer.catalog.clone()).await?;
        let error = writer
            .apply(
                &[],
                vec![(replacement.clone(), change("grace", 2, Some("{}")))],
                BTreeMap::new(),
            )
            .await
            .expect_err("a different source must truncate before reusing a Glue name");
        assert!(
            error.to_string().contains("belongs to another source"),
            "{error:#}"
        );
        writer
            .apply(
                std::slice::from_ref(&replacement),
                vec![(replacement.clone(), change("grace", 2, Some("{}")))],
                BTreeMap::new(),
            )
            .await?;
        assert_eq!(writer.tables.keys().collect::<Vec<_>>(), [&replacement]);
        assert_eq!(
            read(&writer.tables[&replacement]).await?,
            vec![change("grace", 2, Some("{}"))]
        );
    }
    Ok(())
}

#[tokio::test]
async fn retirement_follows_the_selection() -> Result<()> {
    let catalog = memory_catalog().await?;
    let mut writer = open(catalog).await?;
    writer
        .apply(&[source("menu"), source("orders")], vec![], BTreeMap::new())
        .await?;
    let retired = |writer: &IcebergChangeWriter, table: &str| {
        writer.tables[&source(table)]
            .metadata()
            .properties()
            .get(RETIRED_PROPERTY)
            .cloned()
    };
    writer = open(writer.catalog.clone()).await?;
    writer.retire_unselected(&[source("menu")]).await?;
    assert_eq!(retired(&writer, "menu"), None);
    assert_eq!(retired(&writer, "orders").as_deref(), Some("true"));
    writer
        .retire_unselected(&[source("menu"), source("orders")])
        .await?;
    assert_eq!(retired(&writer, "orders").as_deref(), Some("false"));
    Ok(())
}

#[tokio::test]
async fn foreign_tables_are_checked_when_used_or_reconciled() -> Result<()> {
    let catalog = memory_catalog().await?;
    open(catalog.clone()).await?;
    catalog
        .create_table(
            &NamespaceIdent::new("convex_chess_wandering_fish_513".to_owned()),
            TableCreation::builder()
                .name("app__menu".to_owned())
                .schema(metadata_schema()?)
                .build(),
        )
        .await?;
    let mut writer = open(catalog).await?;
    writer
        .apply(
            &[],
            vec![(source("orders"), change("order", 1, Some("{}")))],
            BTreeMap::new(),
        )
        .await?;
    assert_eq!(changes(&writer, "orders").await?.len(), 1);

    let error = writer
        .apply(
            &[],
            vec![(source("menu"), change("burger", 1, Some("{}")))],
            BTreeMap::new(),
        )
        .await
        .expect_err("appending to a foreign table must fail");
    assert!(error.to_string().contains("not written by"), "{error:#}");
    let error = writer
        .apply(&[source("menu")], vec![], BTreeMap::new())
        .await
        .expect_err("truncating a foreign table must fail");
    assert!(error.to_string().contains("not written by"), "{error:#}");
    let error = writer
        .retire_unselected(&[])
        .await
        .expect_err("retirement must validate the full catalog");
    assert!(error.to_string().contains("not written by"), "{error:#}");
    Ok(())
}

#[tokio::test]
async fn a_known_retired_set_loads_only_the_tables_a_page_uses() -> Result<()> {
    let catalog = memory_catalog().await?;
    let mut writer = open(catalog.clone()).await?;
    writer
        .apply(&[source("menu"), source("orders")], vec![], BTreeMap::new())
        .await?;
    writer
        .retire_unselected(&[source("menu"), source("orders")])
        .await?;
    let locations = writer.locations().clone();
    assert_eq!(writer.retired(), Some(&BTreeSet::new()));

    // Forget the tables, as a fresh staged writer starts.
    for name in locations.keys() {
        catalog
            .drop_table(&TableIdent::new(writer.namespace.clone(), name.clone()))
            .await?;
    }
    let mut writer = open(catalog.clone()).await?;
    writer.locations = locations.clone();
    writer.unregistered = locations;
    writer.retired = Some(BTreeSet::new());
    let registered = async |writer: &IcebergChangeWriter| -> Result<Vec<String>> {
        Ok(catalog
            .list_tables(&writer.namespace)
            .await?
            .into_iter()
            .map(|ident| ident.name().to_owned())
            .collect())
    };

    writer
        .apply(
            &[],
            vec![(source("menu"), change("burger", 1, Some("{}")))],
            BTreeMap::new(),
        )
        .await?;
    writer
        .retire_unselected(&[source("menu"), source("orders")])
        .await?;
    assert_eq!(registered(&writer).await?, ["app__menu"]);

    writer.retire_unselected(&[source("menu")]).await?;
    assert_eq!(registered(&writer).await?.len(), 2);
    assert_eq!(
        writer.retired(),
        Some(&BTreeSet::from(["app__orders".to_owned()]))
    );
    assert_eq!(
        writer.tables[&source("orders")].metadata().properties()[RETIRED_PROPERTY],
        "true"
    );
    Ok(())
}

#[tokio::test]
async fn an_export_in_the_json_format_keeps_its_payload_column() -> Result<()> {
    let catalog = memory_catalog().await?;
    let mut writer = IcebergChangeWriter::open(
        catalog.clone(),
        "convex_chess_wandering_fish_513",
        "memory://warehouse",
        vec![],
        Format::Json,
    )
    .await?;
    writer
        .apply(
            &[],
            vec![(source("menu"), change("burger", 10, Some("10")))],
            BTreeMap::new(),
        )
        .await?;
    let ident = TableIdent::new(
        writer.namespace.clone(),
        IcebergChangeWriter::table_name(&source("menu"))?,
    );
    let table = catalog.load_table(&ident).await?;
    assert_eq!(
        table.metadata().current_schema().as_struct(),
        json::change_log_schema()?.as_struct()
    );
    assert_eq!(
        table.metadata().properties()[FORMAT_PROPERTY],
        "convex-change-log-json-v1"
    );
    // A typed writer stops at a JSON table instead of appending to it.
    let mut typed = open(catalog).await?;
    let error = typed
        .apply(
            &[],
            vec![(source("menu"), change("soup", 11, None))],
            BTreeMap::new(),
        )
        .await
        .unwrap_err();
    assert!(
        error.to_string().contains("convex-change-log-json-v1"),
        "{error}"
    );
    Ok(())
}

#[tokio::test]
async fn a_new_table_starts_with_its_seeds() -> Result<()> {
    let catalog = memory_catalog().await?;
    let mut writer = open(catalog.clone()).await?;
    let page = vec![(source("menu"), change("burger", 10, Some("10")))];
    assert_eq!(
        writer.new_tables(&[source("empty")], &page)?,
        BTreeSet::from([source("empty"), source("menu")])
    );
    let shape = ReducedShape::Object(BTreeMap::from([(
        "v".parse()?,
        ReducedField {
            optional: false,
            shape: ReducedShape::Union(BTreeSet::from([ReducedShape::Int64, ReducedShape::String])),
        },
    )]));
    let seeds = BTreeMap::from([
        (source("menu"), columns::seeds(&shape, |_| None)?),
        (source("empty"), columns::seeds(&shape, |_| None)?),
    ]);
    writer.apply(&[source("empty")], page, seeds).await?;
    // A truncated table is recreated with its seeds too.
    let empty = TableIdent::new(
        writer.namespace.clone(),
        IcebergChangeWriter::table_name(&source("empty"))?,
    );
    let empty = catalog.load_table(&empty).await?;
    assert!(empty
        .metadata()
        .current_schema()
        .field_by_name("v")
        .is_some());
    // The seed typed `v` as JSON before the page's int64 could make it a long.
    let ident = TableIdent::new(
        writer.namespace.clone(),
        IcebergChangeWriter::table_name(&source("menu"))?,
    );
    let table = catalog.load_table(&ident).await?;
    let v = table
        .metadata()
        .current_schema()
        .field_by_name("v")
        .context("seeded column")?;
    assert_eq!(v.doc.as_deref(), Some(columns::JSON_DOC));
    assert_eq!(changes(&writer, "menu").await?.len(), 1);
    // Known tables are not new again; truncated ones are.
    let next = vec![(source("menu"), change("soup", 11, Some("\"x\"")))];
    assert!(writer.new_tables(&[], &next)?.is_empty());
    assert_eq!(
        writer.new_tables(&[source("menu")], &[])?,
        BTreeSet::from([source("menu")])
    );
    Ok(())
}
