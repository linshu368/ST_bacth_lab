import { describe, expect, it } from 'vitest';
import { batchLabQueryKeys } from './query-keys';

describe('batchLabQueryKeys', () => {
  it('isolates server cache by backend and source environment', () => {
    expect(
      batchLabQueryKeys.environment({
        backend_environment: 'development',
        source_environment: 'test',
        capabilities: { sample_preview: false, experiment_execution: false },
      })
    ).toEqual(['batch-lab', 'development', 'test']);
  });

  it('scopes processor versions by the active environments', () => {
    expect(
      batchLabQueryKeys.processors({
        backend_environment: 'production',
        source_environment: 'production',
        capabilities: { sample_preview: true, experiment_execution: false },
      })
    ).toEqual(['batch-lab', 'production', 'production', 'processors']);
  });

  it('scopes experiments by the active environments', () => {
    expect(
      batchLabQueryKeys.experiments({
        backend_environment: 'test',
        source_environment: 'test',
        capabilities: { sample_preview: true, experiment_execution: true },
      })
    ).toEqual(['batch-lab', 'test', 'test', 'experiments']);
  });

  it('scopes experiment detail by environment and id', () => {
    expect(
      batchLabQueryKeys.experiment(
        {
          backend_environment: 'production',
          source_environment: 'test',
          capabilities: { sample_preview: true, experiment_execution: true },
        },
        '35d2159d-dcea-46e9-aab2-8c68bd14e307'
      )
    ).toEqual([
      'batch-lab',
      'production',
      'test',
      'experiments',
      '35d2159d-dcea-46e9-aab2-8c68bd14e307',
    ]);
  });
});
