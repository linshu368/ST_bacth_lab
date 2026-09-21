import { describe, expect, it } from 'vitest';
import {
  buildProcessorConfig,
  experimentProgress,
  parseRegexRules,
  parseSampling,
  parseSqlParameters,
} from './workbench';

describe('workbench helpers', () => {
  it('parses SQL parameters without accepting nested objects', () => {
    expect(parseSqlParameters('{"min_turn":60,"enabled":true,"segment":null}')).toEqual({
      min_turn: 60,
      enabled: true,
      segment: null,
    });
    expect(() => parseSqlParameters('{"nested":{"bad":true}}')).toThrow(
      'SQL 参数仅支持字符串、数字、布尔值或 null'
    );
  });

  it('parses sampling numbers', () => {
    expect(parseSampling('{"temperature":0.7,"top_p":0.9}')).toEqual({
      temperature: 0.7,
      top_p: 0.9,
    });
    expect(() => parseSampling('{"temperature":"0.7"}')).toThrow('采样参数值必须是有限数字');
  });

  it('validates regex processor rules before sending them to the backend', () => {
    expect(
      parseRegexRules('[{"pattern":"\\\\[x\\\\]","flags":"g","replacement":"<b>x</b>"}]')
    ).toEqual([{ pattern: '\\[x\\]', flags: 'g', replacement: '<b>x</b>' }]);
    expect(() => parseRegexRules('[{"pattern":"(","flags":"g","replacement":""}]')).toThrow(
      '不是有效正则'
    );
  });

  it('builds none and regex processor configs', () => {
    expect(buildProcessorConfig('none_v1', '[]')).toEqual({ protocol: 'none_v1' });
    expect(buildProcessorConfig('regex_json_v1', '[]')).toMatchObject({
      protocol: 'regex_json_v1',
      rules: [],
    });
  });

  it('calculates experiment progress from completed and failed attempts', () => {
    expect(
      experimentProgress({
        id: '35d2159d-dcea-46e9-aab2-8c68bd14e307',
        name: 'experiment',
        sample_set_id: '87fce0db-a75e-45b7-87be-b8e7edc8ae8f',
        source_environment: 'test',
        status: 'running',
        variants: [
          {
            key: 'a',
            name: 'A',
            model_id: 'model-a',
            openrouter_model_id: 'openrouter/a',
            tier: 'standard',
            is_free: false,
            sampling: {},
            processor_version_id: null,
            max_turns: 1,
          },
          {
            key: 'b',
            name: 'B',
            model_id: 'model-b',
            openrouter_model_id: 'openrouter/b',
            tier: 'standard',
            is_free: false,
            sampling: {},
            processor_version_id: null,
            max_turns: 1,
          },
        ],
        total_attempts: 10,
        completed_attempts: 6,
        failed_attempts: 1,
        created_at: '2026-09-11T06:00:00.000Z',
        started_at: null,
        completed_at: null,
      })
    ).toBe(70);
  });
});
