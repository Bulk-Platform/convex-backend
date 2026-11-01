//! Optional glibc page reclamation shared by exports and the self-hosted timer.

#[cfg(all(target_os = "linux", target_env = "gnu"))]
use std::sync::Mutex;
use std::time::Duration;

#[derive(Clone, Copy)]
pub enum TrimReason {
    Export,
    Periodic,
}

impl TrimReason {
    fn label(self) -> &'static str {
        match self {
            Self::Export => "export",
            Self::Periodic => "periodic",
        }
    }
}

/// Zero disables periodic cleanup. Reject accidental high-frequency purging.
pub fn periodic_trim_interval(seconds: u64) -> anyhow::Result<Option<Duration>> {
    match seconds {
        0 => Ok(None),
        1..60 => anyhow::bail!("ALLOCATOR_MALLOC_TRIM_INTERVAL_SECS must be zero or at least 60"),
        _ => Ok(Some(Duration::from_secs(seconds))),
    }
}

#[cfg(all(target_os = "linux", target_env = "gnu"))]
mod glibc {
    use common::runtime::tokio_spawn_blocking;
    use metrics::{
        log_counter_with_labels,
        register_convex_counter,
        register_convex_histogram,
        StaticMetricLabel,
    };

    use super::*;

    static TRIM_LOCK: Mutex<()> = Mutex::new(());

    register_convex_counter!(
        ALLOCATOR_MALLOC_TRIM_TOTAL,
        "Number of glibc cleanup attempts by reason and result",
        &["reason", "result"]
    );
    register_convex_histogram!(
        ALLOCATOR_MALLOC_TRIM_SECONDS,
        "Time spent running glibc malloc_trim",
        &["reason"]
    );

    pub async fn trim(reason: TrimReason) {
        let result = tokio_spawn_blocking("allocator_malloc_trim", move || {
            let Ok(_guard) = TRIM_LOCK.try_lock() else {
                return None;
            };
            let rss_before = memory_stats::memory_stats().map(|stats| stats.physical_mem);
            // SAFETY: glibc statistics and trim functions take no pointers and
            // synchronize their own allocator state. Zero requests page release
            // without retaining extra padding at the top of the main heap.
            let before = unsafe { libc::mallinfo2() };
            let started = std::time::Instant::now();
            let released = unsafe { libc::malloc_trim(0) } != 0;
            let duration = started.elapsed();
            let after = unsafe { libc::mallinfo2() };
            let rss_after = memory_stats::memory_stats().map(|stats| stats.physical_mem);
            let reclaimed = rss_before.zip(rss_after).map(|(a, b)| a.saturating_sub(b));
            tracing::info!(
                reason = reason.label(),
                released,
                duration_seconds = duration.as_secs_f64(),
                rss_before_bytes = rss_before,
                rss_after_bytes = rss_after,
                rss_reclaimed_bytes = reclaimed,
                arena_allocated_before_bytes = before.uordblks,
                arena_free_before_bytes = before.fordblks,
                mmap_before_bytes = before.hblkhd,
                arena_allocated_after_bytes = after.uordblks,
                arena_free_after_bytes = after.fordblks,
                mmap_after_bytes = after.hblkhd,
                "glibc malloc_trim completed"
            );
            Some((released, duration, reclaimed))
        })
        .await;
        let outcome = match result {
            Ok(Some((released, duration, reclaimed))) => {
                metrics::log_distribution_with_labels(
                    &ALLOCATOR_MALLOC_TRIM_SECONDS,
                    duration.as_secs_f64(),
                    vec![StaticMetricLabel::new("reason", reason.label())],
                );
                if let TrimReason::Export = reason {
                    crate::exports::metrics::log_malloc_trim(duration, released, reclaimed);
                }
                if released {
                    "released"
                } else {
                    "no_release"
                }
            },
            Ok(None) => "overlap_skipped",
            Err(error) => {
                tracing::warn!(reason = reason.label(), %error, "glibc cleanup worker failed");
                if let TrimReason::Export = reason {
                    crate::exports::metrics::log_malloc_trim_join_error();
                }
                "join_error"
            },
        };
        log_counter_with_labels(
            &ALLOCATOR_MALLOC_TRIM_TOTAL,
            1,
            vec![
                StaticMetricLabel::new("reason", reason.label()),
                StaticMetricLabel::new("result", outcome),
            ],
        );
    }
}

pub async fn trim_allocator(reason: TrimReason) {
    #[cfg(all(target_os = "linux", target_env = "gnu"))]
    glibc::trim(reason).await;
    #[cfg(not(all(target_os = "linux", target_env = "gnu")))]
    tracing::warn!(
        reason = reason.label(),
        "glibc cleanup unavailable on this platform"
    );
}
