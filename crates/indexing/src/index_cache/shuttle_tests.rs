//! Shuttle-based concurrency tests.
//!
//! Run with: `cargo test -p indexing --features shuttle-testing`
//!
//! Shuttle replaces all synchronization primitives (DashMap,
//! parking_lot::Mutex, moka::sync::Cache) with intercepted versions and
//! systematically explores thread interleavings to find race conditions that
//! OS-based stress tests may miss. The swaps are gated on the
//! `shuttle-testing` feature, so production builds (and the non-shuttle unit
//! tests) keep the standard primitives.
//!
//! Each `check_random` closure is the complete scenario for one shuttle run;
//! shuttle calls it hundreds of times with different scheduling decisions.

use std::{
    iter,
    sync::Arc,
};

use common::{
    bootstrap_model::index::{
        database_index::IndexedFields,
        IndexMetadata,
        INDEX_TABLE,
    },
    document::{
        CreationTime,
        ResolvedDocument,
    },
    document_index_keys::{
        DatabaseIndexWrite,
        Update,
    },
    index::IndexKeyBytes,
    interval::Interval,
    query::{
        CursorPosition,
        Order,
    },
    testing::TestIdGenerator,
    types::{
        unchecked_repeatable_ts,
        GenericIndexName,
        IndexId,
        TableName,
        TabletIndexName,
        Timestamp,
    },
};
use shuttle::{
    scheduler::{
        PctScheduler,
        RandomScheduler,
    },
    sync::Barrier,
    Config,
    Runner,
};
use value::{
    assert_obj,
    ResolvedDocumentId,
};

use super::*;
use crate::{
    index_reader::IndexPage,
    index_registry::IndexRegistry,
};

fn check_random_big_stack<F>(f: F, iterations: usize)
where
    F: Fn() + Send + Sync + 'static,
{
    let mut config = Config::default();
    config.stack_size = 4 * 1024 * 1024;
    Runner::new(RandomScheduler::new(iterations), config).run(f);
}

/// Shared per-run test context. Cheap to `clone` — `IndexCacheHandle` and the
/// `Arc` fields all point at the same underlying cache — so each worker thread
/// gets its own handle into the same cache via [`Ctx::spawn`]. The helper
/// methods fill in the arguments that never vary across these tests
/// (`Interval::all()`, an empty page, the single test index/registry), leaving
/// each call site to spell out only what the scenario actually cares about.
#[derive(Clone)]
struct Ctx {
    handle: IndexCacheHandle,
    write_log: Arc<MockWriteLogReader>,
    index_id: IndexId,
    index_name: TabletIndexName,
    registry: Arc<IndexRegistry>,
    write_key: IndexKeyBytes,
    dummy_doc_id: ResolvedDocumentId,
    /// The test index's own `_index` row id, used to drive a metadata
    /// modification of that index.
    index_doc_id: ResolvedDocumentId,
}

struct PausingWriteLogReader {
    inner: Arc<MockWriteLogReader>,
    index_table: TabletIndexName,
    validated: Arc<Barrier>,
    resume: Arc<Barrier>,
}

impl WriteLogIndexReader for PausingWriteLogReader {
    fn iter_writes_after<'a>(
        &self,
        index_name: &TabletIndexName,
        ts: Timestamp,
        storage: &'a mut ErasedSlot,
    ) -> anyhow::Result<Box<dyn Iterator<Item = &'a DatabaseIndexWrite> + 'a>> {
        let writes = self.inner.iter_writes_after(index_name, ts, storage)?;
        if index_name != &self.index_table {
            return Ok(writes);
        }
        // Index metadata is the final validation check. Pause after exhausting
        // its snapshot so subsequent writes cannot change the validation result.
        let mut pause = Some((self.validated.clone(), self.resume.clone()));
        Ok(Box::new(writes.chain(iter::from_fn(move || {
            if let Some((validated, resume)) = pause.take() {
                validated.wait();
                resume.wait();
            }
            None
        }))))
    }
}

struct PausedPopulate {
    thread: shuttle::thread::JoinHandle<()>,
    key: CacheKey,
    resume: Arc<Barrier>,
}

impl PausedPopulate {
    fn finish(self) {
        self.resume.wait();
        self.thread.join().unwrap();
    }
}

impl Ctx {
    fn pause_populate(&self, ts: RepeatableTimestamp) -> PausedPopulate {
        let validated = Arc::new(Barrier::new(2));
        let resume = Arc::new(Barrier::new(2));
        let mut ctx = self.clone();
        ctx.handle.write_log_reader = Arc::new(PausingWriteLogReader {
            inner: self.write_log.clone(),
            index_table: TabletIndexName::by_id(self.handle.index_tablet),
            validated: validated.clone(),
            resume: resume.clone(),
        });
        let thread = ctx.spawn(move |ctx| ctx.populate(ts, Order::Asc, 100));
        validated.wait();
        let key = CacheKey {
            deployment_id: self.handle.deployment_id,
            index_id: self.index_id,
            interval: Arc::new(Interval::all()),
            order: Order::Asc,
            max_size: 100,
        };
        let entry = self.handle.shared_cache.cache.get(&key).unwrap();
        assert!(entry.index_page_at_ts(ts).is_none());
        PausedPopulate {
            thread,
            key,
            resume,
        }
    }

    /// Spawn a worker thread, handing it its own clone of the context (a
    /// fresh handle into the same shared cache).
    fn spawn(&self, f: impl FnOnce(Ctx) + Send + 'static) -> shuttle::thread::JoinHandle<()> {
        let ctx = self.clone();
        shuttle::thread::spawn(move || f(ctx))
    }

    /// Populate the full interval with an empty page at `ts`.
    fn populate(&self, ts: RepeatableTimestamp, order: Order, max_size: usize) {
        self.handle.populate(
            self.index_id,
            Arc::new(Interval::all()),
            ts,
            order,
            max_size,
            empty_page(),
            &self.registry,
        );
    }

    /// Read the full-interval entry at `ts`.
    fn get(
        &self,
        ts: RepeatableTimestamp,
        order: Order,
        max_size: usize,
    ) -> Option<(IndexPage, RepeatableTimestamp)> {
        self.handle.get(
            self.index_id,
            Arc::new(Interval::all()),
            ts,
            order,
            max_size,
        )
    }

    /// Mirror a production write: append `write_key` to the write log at `ts`,
    /// then notify the cache via `apply_writes`.
    fn apply_write(&self, ts: Timestamp) {
        let write = DatabaseIndexWrite {
            document_id: self.dummy_doc_id,
            update: Update {
                old: None,
                new: Some(self.write_key.clone()),
            },
            new_document: None,
        };
        self.write_log
            .add_write(self.index_name.clone(), ts, write.clone());
        let index_id = self.index_id;
        let index_name = self.index_name.clone();
        self.handle.apply_writes(
            [(&self.index_name, iter::once(&write))],
            &|n: &TabletIndexName| (*n == index_name).then_some(index_id),
        );
    }

    /// Drive moka's size-based eviction to completion.
    fn run_pending_tasks(&self) {
        self.handle.shared_cache.cache.run_pending_tasks();
    }

    /// Mirror a production index modification at `ts`: a write to the `_index`
    /// table whose document is the test index's own `_index` row. As in
    /// `LogWriter::append`, the write is appended to the write log *before*
    /// `apply_writes` runs. `apply_writes` recovers the modified `IndexId` from
    /// `document_id.internal_id()` and evicts that index from the cache.
    fn modify_index(&self, ts: Timestamp) {
        let write = DatabaseIndexWrite {
            document_id: self.index_doc_id,
            update: Update {
                old: None,
                new: None,
            },
            new_document: None,
        };
        self.write_log.add_write(
            TabletIndexName::by_id(self.index_doc_id.tablet_id),
            ts,
            write.clone(),
        );
        let index_id = self.index_id;
        let index_name = self.index_name.clone();
        self.handle.apply_writes(
            [(
                &TabletIndexName::by_id(self.index_doc_id.tablet_id),
                iter::once(&write),
            )],
            &|n: &TabletIndexName| (*n == index_name).then_some(index_id),
        );
    }
}

fn setup() -> Ctx {
    setup_with_capacity(10 * 1024 * 1024)
}

fn setup_with_capacity(max_weight: u64) -> Ctx {
    let mut id_gen = TestIdGenerator::new();

    // _index.by_id — required by IndexRegistry::bootstrap
    let index_tablet = id_gen.system_table_id(&INDEX_TABLE).tablet_id;
    let by_id_doc = ResolvedDocument::new(
        id_gen.system_generate(&INDEX_TABLE),
        CreationTime::ONE,
        IndexMetadata::new_enabled(
            GenericIndexName::by_id(index_tablet),
            IndexedFields::by_id(),
        )
        .try_into()
        .unwrap(),
    )
    .unwrap();

    // The test index
    let table: TableName = "t".parse().unwrap();
    let tablet_id = id_gen.user_table_id(&table).tablet_id;
    let index_name: TabletIndexName = GenericIndexName::by_id(tablet_id);
    let index_doc_id = id_gen.system_generate(&INDEX_TABLE);
    let index_doc = ResolvedDocument::new(
        index_doc_id,
        CreationTime::ONE,
        IndexMetadata::new_enabled(index_name.clone(), IndexedFields::by_id())
            .try_into()
            .unwrap(),
    )
    .unwrap();
    let index_id: IndexId = index_doc_id.internal_id().into();

    let registry =
        IndexRegistry::bootstrap(&id_gen, [&by_id_doc, &index_doc].iter().copied()).unwrap();

    // Create a document whose by_id index key serves as our test write key.
    let doc_id = id_gen.user_generate(&table);
    let doc = ResolvedDocument::new(doc_id, CreationTime::ONE, assert_obj!()).unwrap();
    let write_key = doc.index_key(&IndexedFields::by_id()).to_bytes();
    let dummy_doc_id = doc_id;

    let write_log = Arc::new(MockWriteLogReader::new());
    let cache = IndexCache::new(max_weight);
    let handle = cache.new_handle().build(index_tablet, write_log.clone());

    Ctx {
        handle,
        write_log,
        index_id,
        index_name,
        registry: Arc::new(registry),
        write_key,
        dummy_doc_id,
        index_doc_id,
    }
}

fn empty_page() -> IndexPage {
    IndexPage {
        entries: vec![],
        cursor: CursorPosition::End,
    }
}
