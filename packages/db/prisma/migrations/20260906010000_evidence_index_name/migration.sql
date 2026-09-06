-- Use a stable explicit name below PostgreSQL's 63-byte identifier limit.
ALTER INDEX "PerformanceEvidence_userId_sport_metric_benchmark_occurredAt_idx"
  RENAME TO "PerformanceEvidence_user_benchmark_date_idx";
