//! A per-deployment worker that applies queued operations to V6 in FIFO order.
use std::{
    sync::{
        atomic::{
            AtomicBool,
            Ordering,
        },
        Arc,
        OnceLock,
    },
    time::Duration,
};

use anyhow::Context as _;
use common::{
    backoff::Backoff,
    errors::{
        is_db_deadlock_error,
        is_transient_db_error,
        LeaseLostError,
    },
    persistence::{
        ConflictStrategy,
        DocumentLogEntry,
        IndexBackfillEntry,
        Persistence as PersistenceTrait,
        PersistenceGlobalKey,
        PersistenceIndexEntry,
    },
    runtime::Runtime,
    types::{
        DeploymentId,
        PersistenceIndexId,
        Timestamp,
    },
    value::{
        InternalDocumentId,
        TabletId,
    },
};
use serde_json::Value as JsonValue;
use tokio::{
    sync::{
        mpsc,
        oneshot,
        Semaphore,
    },
    time::Instant,
};

use super::{
    config::Settings,
    metrics,
    state::{
        self,
        ReplicaHandoffState,
    },
    ReplicaTarget,
};

pub(crate) enum ReplayOperation {
    Write {
        documents: Vec<DocumentLogEntry>,
        indexes: Vec<PersistenceIndexEntry>,
        conflict_strategy: ConflictStrategy,
    },
    WriteIndexBackfill {
        entries: Vec<IndexBackfillEntry>,
    },
    ReconcileIndexBackfill {
        index: PersistenceIndexId,
    },
    DeleteIndexBackfillMarkers {
        index: PersistenceIndexId,
    },
    DeleteDocuments {
        documents: Vec<(Timestamp, InternalDocumentId)>,
    },
    DeleteTabletDocuments {
        tablet_id: TabletId,
        chunk_size: usize,
    },
    WritePersistenceGlobal {
        key: PersistenceGlobalKey,
        value: JsonValue,
    },
}

enum ReplayQueueMessage<RT: Runtime> {
    Replay {
        // Queued operations keep the writer alive. The worker holds only the
        // receiver, so the channel closes once these and the source are dropped.
        replica: Arc<ReplicaWriter<RT>>,
        operation: ReplayOperation,
        reply: oneshot::Sender<anyhow::Result<u64>>,
    },
    NotifyAfterPriorReplay(oneshot::Sender<()>),
}

pub(crate) struct ReplicaWriter<RT: Runtime> {
    /// Set once this writer owns the registration; a pending writer queues
    /// operations until then.
    v6: OnceLock<Arc<dyn PersistenceTrait>>,
    /// Releases the worker once `v6` is set. Dropped on stop, so a pending
    /// worker skips its queue instead.
    activation: parking_lot::Mutex<Option<oneshot::Sender<()>>>,
    pub(super) target: ReplicaTarget<RT>,
    /// Metrics use the source V5 cluster's name.
    pub(super) cluster_name: String,
    pub(super) deployment_id: DeploymentId,
    pub(super) instance_name: String,
    /// Source V5 lease timestamp, checked when updating the handoff state to
    /// protect a newer writer's state from stale updates.
    pub(super) lease_ts: i64,
    /// Stops replay and comparisons permanently on retirement, lease loss,
    /// or clean shutdown.
    stopped: AtomicBool,
    queue: mpsc::Sender<ReplayQueueMessage<RT>>,
    pub(super) settings: Settings,
    /// Held by sampled scans from sampling through outcome logging.
    pub(super) comparison_permits: Arc<Semaphore>,
    /// Held only while a comparison reads V6.
    pub(super) replica_read_permits: Semaphore,
    writer_state_gauge: Arc<metrics::WriterStateGauge>,
}

impl<RT: Runtime> ReplicaWriter<RT> {
    pub(super) fn new(
        v6: Option<Arc<dyn PersistenceTrait>>,
        target: ReplicaTarget<RT>,
        source: ReplicaHandoffState,
        settings: Settings,
        writer_state_gauge: Arc<metrics::WriterStateGauge>,
    ) -> Arc<Self> {
        let (queue, mut receiver) = mpsc::channel(settings.max_queued_jobs);
        let (activate, activated) = oneshot::channel();
        let replica = Arc::new(Self {
            v6: OnceLock::new(),
            activation: parking_lot::Mutex::new(Some(activate)),
            target,
            cluster_name: source.cluster_name,
            deployment_id: source.deployment_id,
            instance_name: source.instance_name,
            lease_ts: source.lease_ts,
            stopped: AtomicBool::new(false),
            queue,
            comparison_permits: Arc::new(Semaphore::new(settings.max_concurrent_comparisons)),
            replica_read_permits: Semaphore::new(settings.max_concurrent_replica_reads),
            settings,
            writer_state_gauge,
        });
        match v6 {
            Some(v6) => replica.activate(v6),
            None => replica
                .writer_state_gauge
                .set(metrics::WriterState::Pending),
        }
        common::runtime::tokio_spawn("v6_replica_worker", async move {
            // A pending writer holds its jobs until the handoff resolves. A
            // dropped sender means it stopped, and the loop skips them.
            let _ = activated.await;
            while let Some(message) = receiver.recv().await {
                match message {
                    ReplayQueueMessage::Replay {
                        replica,
                        operation,
                        reply,
                    } => {
                        let outcome = replica.run(&operation).await;
                        metrics::add_queued(&replica.cluster_name, -1.0);
                        let _ = reply.send(outcome);
                    },
                    ReplayQueueMessage::NotifyAfterPriorReplay(reply) => {
                        let _ = reply.send(());
                    },
                }
            }
        });
        replica
    }

    pub(crate) fn is_stopped(&self) -> bool {
        self.stopped.load(Ordering::Acquire)
    }

    pub(crate) fn is_active(&self) -> bool {
        self.v6.get().is_some() && !self.is_stopped()
    }

    pub(super) fn v6(&self) -> anyhow::Result<&Arc<dyn PersistenceTrait>> {
        self.v6.get().context("the V6 replica is not active")
    }

    fn activate(&self, v6: Arc<dyn PersistenceTrait>) {
        let mut activation = self.activation.lock();
        if self.is_stopped() || self.v6.set(v6).is_err() {
            return;
        }
        self.writer_state_gauge.set(metrics::WriterState::Ready);
        if let Some(activate) = activation.take() {
            let _ = activate.send(());
        }
    }

    /// Call before returning the V5 result so operations issued after that
    /// response enter the queue after this one.
    pub(crate) fn enqueue(
        self: &Arc<Self>,
        operation: ReplayOperation,
    ) -> Option<oneshot::Receiver<anyhow::Result<u64>>> {
        if self.is_stopped() {
            metrics::log_job(&self.cluster_name, metrics::JobOutcome::Skipped);
            return None;
        }
        let (reply, result) = oneshot::channel();
        metrics::add_queued(&self.cluster_name, 1.0);
        if let Err(error) = self.queue.try_send(ReplayQueueMessage::Replay {
            replica: self.clone(),
            operation,
            reply,
        }) {
            metrics::add_queued(&self.cluster_name, -1.0);
            let reason = match error {
                mpsc::error::TrySendError::Full(_) => metrics::RetireReason::QueueFull,
                mpsc::error::TrySendError::Closed(_) => metrics::RetireReason::JobFailed,
            };
            self.retire(
                reason,
                &anyhow::anyhow!("replica worker could not accept a job"),
            );
            return None;
        }
        Some(result)
    }

    async fn run(self: &Arc<Self>, operation: &ReplayOperation) -> anyhow::Result<u64> {
        if self.is_stopped() {
            metrics::log_job(&self.cluster_name, metrics::JobOutcome::Skipped);
            return Ok(0);
        }
        let result = self.apply_with_retries(operation).await;
        match &result {
            Ok(_) => metrics::log_job(&self.cluster_name, metrics::JobOutcome::Applied),
            // A newer writer or deletion now controls the replica's lifetime.
            Err(error) if error.is::<LeaseLostError>() => {
                metrics::log_job(&self.cluster_name, metrics::JobOutcome::Skipped);
                if self.stop(metrics::WriterState::Displaced) {
                    tracing::info!(
                        instance_name = %self.instance_name,
                        "V6 replica displaced by another writer"
                    );
                }
            },
            Err(error) => {
                metrics::log_job(&self.cluster_name, metrics::JobOutcome::Failed);
                self.retire(metrics::RetireReason::JobFailed, error);
            },
        }
        result
    }

    /// An ambiguous commit may have written keys already; a duplicate-key
    /// error on retry retires the replica.
    async fn apply_with_retries(&self, operation: &ReplayOperation) -> anyhow::Result<u64> {
        let deadline = Instant::now() + self.settings.job_retry;
        let mut backoff = Backoff::new(Duration::from_millis(50), Duration::from_secs(2));
        loop {
            match self.apply(operation).await {
                Err(error)
                    if (is_transient_db_error(&error) || is_db_deadlock_error(&error))
                        && Instant::now() < deadline
                        && !self.is_stopped() =>
                {
                    tracing::warn!("Retrying a V6 replica job: {error:#}");
                    let delay = backoff.fail(&mut rand::rng());
                    tokio::time::sleep(delay).await;
                },
                result => return result,
            }
        }
    }

    async fn apply(&self, operation: &ReplayOperation) -> anyhow::Result<u64> {
        let v6 = self.v6()?;
        match operation {
            ReplayOperation::Write {
                documents,
                indexes,
                conflict_strategy,
            } => {
                v6.write(documents, indexes, *conflict_strategy).await?;
                Ok(0)
            },
            ReplayOperation::WriteIndexBackfill { entries } => {
                v6.write_index_backfill(entries).await?;
                Ok(0)
            },
            ReplayOperation::ReconcileIndexBackfill { index } => {
                v6.reconcile_index_backfill(*index).await?;
                Ok(0)
            },
            ReplayOperation::DeleteIndexBackfillMarkers { index } => {
                v6.delete_index_backfill_markers_chunk(*index).await
            },
            ReplayOperation::DeleteDocuments { documents } => {
                Ok(v6.delete(documents.clone()).await? as u64)
            },
            ReplayOperation::DeleteTabletDocuments {
                tablet_id,
                chunk_size,
            } => Ok(v6.delete_tablet_documents(*tablet_id, *chunk_size).await? as u64),
            ReplayOperation::WritePersistenceGlobal { key, value } => {
                v6.write_persistence_global(*key, value.clone()).await?;
                Ok(0)
            },
        }
    }

    /// Acknowledges earlier operations after success, failure, or skipping.
    pub(crate) async fn wait_for_prior_replay(&self, deadline: Option<Instant>) -> bool {
        let notification = async {
            let (reply, completed) = oneshot::channel();
            self.queue
                .send(ReplayQueueMessage::NotifyAfterPriorReplay(reply))
                .await
                .ok()?;
            completed.await.ok()
        };
        match deadline {
            Some(deadline) => matches!(
                tokio::time::timeout_at(deadline, notification).await,
                Ok(Some(()))
            ),
            None => notification.await.is_some(),
        }
    }

    /// Retention retries marker discovery periodically, so a stale result is
    /// safe. Marker deletions queue behind the reconciliation they depend on.
    pub(crate) async fn index_backfill_marker_indexes(self: &Arc<Self>) -> Vec<PersistenceIndexId> {
        let Some(v6) = self.v6.get().filter(|_| !self.is_stopped()) else {
            return Vec::new();
        };
        match v6.index_backfill_marker_indexes().await {
            Ok(indexes) => indexes,
            Err(error) => {
                self.retire(metrics::RetireReason::JobFailed, &error);
                Vec::new()
            },
        }
    }

    /// The caller must finish all source calls before starting replica
    /// shutdown.
    pub(crate) async fn close(self: &Arc<Self>) {
        if self.is_stopped() {
            return;
        }
        if !self.is_active() {
            // Queued writes were never applied, so no certificate is possible.
            self.retire(
                metrics::RetireReason::UncleanHandoff,
                &anyhow::anyhow!("shut down before the handoff resolved"),
            );
            return;
        }
        let result = tokio::time::timeout(self.settings.apply_wait, async {
            anyhow::ensure!(
                self.wait_for_prior_replay(None).await,
                "replica queue closed"
            );
            anyhow::ensure!(!self.is_stopped(), "replica stopped during shutdown");
            state::record_clean_shutdown(
                &self.target.pool,
                &self.target.db_name,
                self.deployment_id,
                self.lease_ts,
            )
            .await
        })
        .await;
        match result {
            Ok(Ok(())) => {
                self.stop(metrics::WriterState::Closed);
            },
            _ => self.retire(
                metrics::RetireReason::UncleanHandoff,
                &anyhow::anyhow!("replica shutdown did not complete"),
            ),
        }
    }

    fn stop(&self, state: metrics::WriterState) -> bool {
        let mut activation = self.activation.lock();
        if self.stopped.swap(true, Ordering::AcqRel) {
            return false;
        }
        self.writer_state_gauge.set(state);
        activation.take();
        true
    }

    /// Stopping immediately keeps `clean_shutdown` false even if persisting
    /// retirement fails; the next writer will then retire the replica.
    pub(crate) fn retire(self: &Arc<Self>, reason: metrics::RetireReason, error: &anyhow::Error) {
        if !self.stop(metrics::WriterState::Retired) {
            return;
        }
        metrics::log_retirement(&self.cluster_name, reason);
        tracing::warn!(
            instance_name = %self.instance_name,
            "Retiring the V6 replica ({}): {error:#}",
            <&'static str>::from(reason)
        );
        let replica = self.clone();
        common::runtime::tokio_spawn("v6_replica_retire", async move {
            if let Err(error) = replica.record_retirement().await {
                tracing::warn!("Could not record V6 replica retirement: {error:#}");
            }
        });
    }

    async fn record_retirement(&self) -> anyhow::Result<()> {
        if state::retire(
            &self.target.pool,
            &self.target.db_name,
            self.deployment_id,
            self.lease_ts,
        )
        .await?
        {
            super::spawn_delete_data(self.target.clone(), self.deployment_id);
        }
        Ok(())
    }

    pub(crate) async fn is_active_owner(&self) -> anyhow::Result<bool> {
        if self.is_stopped() {
            return Ok(false);
        }
        let state =
            state::read(&self.target.pool, &self.target.db_name, self.deployment_id).await?;
        Ok(
            state.is_some_and(|state| !state.retired && state.lease_ts == self.lease_ts)
                && !self.is_stopped(),
        )
    }
}

enum Handoff {
    /// The previous writer drained its replay and certified its shutdown.
    Certified,
    /// No certificate arrived in time, or another stale writer registered.
    Expired,
    /// A newer writer owns the registration.
    Superseded,
    /// Another process retired the replica.
    Retired,
    Stopped,
}

impl<RT: Runtime> ReplicaWriter<RT> {
    /// Rolling updates start the new conductor before stopping the old one,
    /// so the previous writer is usually still draining when this writer
    /// loads. Queue writes until it certifies a clean shutdown, then take the
    /// registration; retire if the certificate does not arrive in time.
    pub(super) fn resolve_handoff(
        self: &Arc<Self>,
        source: ReplicaHandoffState,
        previous_lease_ts: i64,
    ) {
        let replica = self.clone();
        common::runtime::tokio_spawn("v6_replica_handoff", async move {
            match replica.await_certificate(previous_lease_ts).await {
                Handoff::Certified => replica.claim(&source).await,
                Handoff::Expired => replica.retire(
                    metrics::RetireReason::UncleanHandoff,
                    &anyhow::anyhow!(
                        "the previous writer did not certify a clean shutdown within {:?}",
                        replica.settings.handoff_grace
                    ),
                ),
                Handoff::Superseded => {
                    if replica.stop(metrics::WriterState::Displaced) {
                        tracing::info!(
                            instance_name = %replica.instance_name,
                            "V6 replica displaced by another writer"
                        );
                    }
                },
                Handoff::Retired => {
                    replica.stop(metrics::WriterState::Retired);
                },
                Handoff::Stopped => {},
            }
        });
    }

    async fn await_certificate(&self, previous_lease_ts: i64) -> Handoff {
        let deadline = Instant::now() + self.settings.handoff_grace;
        let poll = (self.settings.handoff_grace / 20)
            .clamp(Duration::from_millis(50), Duration::from_secs(2));
        loop {
            tokio::time::sleep(poll).await;
            if self.is_stopped() {
                return Handoff::Stopped;
            }
            match state::read(&self.target.pool, &self.target.db_name, self.deployment_id).await {
                Ok(Some(current)) if current.retired => return Handoff::Retired,
                Ok(Some(current)) if current.lease_ts >= self.lease_ts => {
                    return Handoff::Superseded;
                },
                Ok(Some(current)) if current.lease_ts != previous_lease_ts => {
                    return Handoff::Expired;
                },
                Ok(Some(current)) if current.clean_shutdown => return Handoff::Certified,
                Ok(Some(_)) => {},
                Ok(None) => return Handoff::Expired,
                Err(error) => {
                    tracing::warn!("Could not read the V6 replica handoff state: {error:#}");
                },
            }
            if Instant::now() >= deadline {
                return Handoff::Expired;
            }
        }
    }

    async fn claim(self: &Arc<Self>, source: &ReplicaHandoffState) {
        match state::register(&self.target.pool, &self.target.db_name, source, false).await {
            Ok(true) => match super::open_v6(&self.target, source).await {
                Ok(v6) => self.activate(v6),
                Err(error) => self.retire(metrics::RetireReason::InitializationFailed, &error),
            },
            Ok(false) => {
                super::spawn_delete_data(self.target.clone(), self.deployment_id);
                self.retire(
                    metrics::RetireReason::UncleanHandoff,
                    &anyhow::anyhow!("the handoff state changed before this writer registered"),
                );
            },
            Err(error) => self.retire(metrics::RetireReason::UncleanHandoff, &error),
        }
    }
}
