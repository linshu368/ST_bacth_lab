import type { BatchLabContext } from '../lib/batch-lab-contracts';

export const batchLabQueryKeys = {
  context: ['batch-lab', 'context'] as const,
  environment(context: BatchLabContext) {
    return ['batch-lab', context.backend_environment, context.source_environment] as const;
  },
  templates(context: BatchLabContext) {
    return [...this.environment(context), 'sql-templates'] as const;
  },
  processors(context: BatchLabContext) {
    return [...this.environment(context), 'processors'] as const;
  },
  sampleSets(context: BatchLabContext) {
    return [...this.environment(context), 'sample-sets'] as const;
  },
  sampleSet(context: BatchLabContext, sampleSetId: string) {
    return [...this.sampleSets(context), sampleSetId] as const;
  },
  sampleSetSamples(context: BatchLabContext, sampleSetId: string, cursor: string | null = null) {
    return [...this.sampleSet(context, sampleSetId), 'samples', cursor ?? 'first'] as const;
  },
  experiments(context: BatchLabContext) {
    return [...this.environment(context), 'experiments'] as const;
  },
  experiment(context: BatchLabContext, experimentId: string) {
    return [...this.experiments(context), experimentId] as const;
  },
  experimentResults(context: BatchLabContext, experimentId: string, cursor: string | null = null) {
    return [...this.experiment(context, experimentId), 'results', cursor ?? 'first'] as const;
  },
};

