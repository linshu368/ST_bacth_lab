export const COMPARISON_SUMMARY_SQL = `WITH pairs AS (
  SELECT a.sample_ordinal,a.turn_index,
    max(CASE WHEN a.variant_key=$2 THEN CASE
      WHEN $4::boolean AND a.data->>'finish_reason'='original_reused' AND COALESCE(a.data->>'source_model_verified','false')<>'true' THEN '线上原始回复（模型待核对）'
      ELSE COALESCE(NULLIF(a.data->>'request_model',''),'模型未记录 / 尚未执行') END END) AS model_a,
    max(CASE WHEN a.variant_key=$3 THEN CASE
      WHEN $4::boolean AND a.data->>'finish_reason'='original_reused' AND COALESCE(a.data->>'source_model_verified','false')<>'true' THEN '线上原始回复（模型待核对）'
      ELSE COALESCE(NULLIF(a.data->>'request_model',''),'模型未记录 / 尚未执行') END END) AS model_b,
    count(*) FILTER (WHERE a.status='succeeded')=2 AS ready,
    max(n.data->>'tag') AS verdict
  FROM lab_attempts a LEFT JOIN lab_annotations n ON n.experiment_id=a.experiment_id
    AND n.sample_ordinal=a.sample_ordinal AND n.turn_index=a.turn_index
  WHERE a.experiment_id=$1::uuid AND a.variant_key IN ($2,$3)
  GROUP BY a.sample_ordinal,a.turn_index
) SELECT COALESCE(model_a,'模型未记录 / 尚未执行') AS model_a,
  COALESCE(model_b,'模型未记录 / 尚未执行') AS model_b,
  count(*)::int AS total,
  count(*) FILTER (WHERE ready AND verdict='preference:' || $2)::int AS a_wins,
  count(*) FILTER (WHERE ready AND verdict='preference:' || $3)::int AS b_wins,
  count(*) FILTER (WHERE ready AND verdict='preference:tie')::int AS ties,
  count(*) FILTER (WHERE NOT ready OR verdict IS NULL OR verdict NOT IN ('preference:' || $2,'preference:' || $3,'preference:tie'))::int AS unrated,
  count(*) FILTER (WHERE NOT ready)::int AS awaiting_results
  FROM pairs GROUP BY model_a,model_b ORDER BY total DESC,model_a,model_b`;

export function comparisonSummary(rows: Array<Record<string, any>>) {
  const totals = { total: 0, a_wins: 0, b_wins: 0, ties: 0, unrated: 0, awaiting_results: 0 };
  for (const row of rows) for (const key of Object.keys(totals) as Array<keyof typeof totals>) totals[key] += Number(row[key]);
  return { ...totals, by_model: rows };
}
