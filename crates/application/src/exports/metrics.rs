#[cfg(all(target_os = "linux", target_env = "gnu"))]
use std::time::Duration;

use errors::ErrorMetadataAnyhowExt as _;
#[cfg(all(target_os = "linux", target_env = "gnu"))]
use metrics::log_distribution;
use metrics::{
    log_counter_with_labels,
    register_convex_counter,
    register_convex_histogram,
    StaticMetricLabel,
};

register_convex_counter!(
    SNAPSHOT_EXPORT_FAILED_TOTAL,
    "Number of snapshot export attempts that failed",
    &["status"]
);
pub fn log_export_failed(e: &anyhow::Error) {
    let status = e.metric_status_label_value();
    log_counter_with_labels(
        &SNAPSHOT_EXPORT_FAILED_TOTAL,
        1,
        vec![StaticMetricLabel::new("status", status)],
    );
}

register_convex_counter!(
    SNAPSHOT_EXPORT_MALLOC_TRIM_TOTAL,
    "Number of post-export glibc malloc_trim attempts",
    &["result"]
);
register_convex_histogram!(
    SNAPSHOT_EXPORT_MALLOC_TRIM_SECONDS,
    "Time spent running glibc malloc_trim after a snapshot export"
);
register_convex_histogram!(
    SNAPSHOT_EXPORT_MALLOC_TRIM_RECLAIMED_BYTES,
    "Process resident memory reclaimed by post-export glibc malloc_trim"
);

#[cfg(all(target_os = "linux", target_env = "gnu"))]
pub fn log_malloc_trim(duration: Duration, released: bool, reclaimed_bytes: Option<usize>) {
    log_counter_with_labels(
        &SNAPSHOT_EXPORT_MALLOC_TRIM_TOTAL,
        1,
        vec![StaticMetricLabel::new(
            "result",
            if released { "released" } else { "no_release" },
        )],
    );
    log_distribution(&SNAPSHOT_EXPORT_MALLOC_TRIM_SECONDS, duration.as_secs_f64());
    if let Some(reclaimed_bytes) = reclaimed_bytes {
        log_distribution(
            &SNAPSHOT_EXPORT_MALLOC_TRIM_RECLAIMED_BYTES,
            reclaimed_bytes as f64,
        );
    }
}

#[cfg(all(target_os = "linux", target_env = "gnu"))]
pub fn log_malloc_trim_join_error() {
    log_counter_with_labels(
        &SNAPSHOT_EXPORT_MALLOC_TRIM_TOTAL,
        1,
        vec![StaticMetricLabel::new("result", "join_error")],
    );
}
