import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  BatchLabClientError,
  copyBatchLabExperiment,
  createBatchLabExperiment,
  deleteBatchLabExperiment,
  downloadBatchLabExperimentJsonl,
  previewBatchLabProcessor,
  request,
  runBatchLabExperimentWorkerOnce,
  stopBatchLabExperiment,
} from './client';

const successSchema = z.object({ success: z.literal(true), data: z.string() });

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe('Batch Lab API client', () => {
  it('does not issue a request for an already cancelled signal', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const controller = new AbortController();
    controller.abort();
    await expect(
      request('/test', successSchema, { signal: controller.signal, apiBaseUrl: 'http://test' })
    ).rejects.toMatchObject({
      kind: 'cancelled',
      code: 'BATCH_LAB_REQUEST_CANCELLED',
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('adds request id without adding authorization', async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      expect(headers.get('X-Request-Id')).toBeTruthy();
      expect(headers.has('Authorization')).toBe(false);
      return new Response(JSON.stringify({ success: true, data: 'ok' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });
    vi.stubGlobal('fetch', fetchMock);
    await expect(request('/test', successSchema, { apiBaseUrl: 'http://test' })).resolves.toEqual({
      success: true,
      data: 'ok',
    });
  });

  it('classifies timeout and aborts the transport', async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_url: string, init?: RequestInit) =>
          new Promise((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () =>
              reject(new DOMException('Aborted', 'AbortError'))
            );
          })
      )
    );
    const pending = request('/test', successSchema, { timeoutMs: 50, apiBaseUrl: 'http://test' });
    const assertion = expect(pending).rejects.toMatchObject({
      kind: 'timeout',
      code: 'BATCH_LAB_TIMEOUT',
    });
    await vi.advanceTimersByTimeAsync(50);
    await assertion;
  });

  it('rejects a successful HTTP response with an invalid protocol shape', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('{}', { status: 200 }))
    );
    await expect(request('/test', successSchema, { apiBaseUrl: 'http://test' })).rejects.toEqual(
      expect.objectContaining<Partial<BatchLabClientError>>({
        kind: 'protocol',
        code: 'BATCH_LAB_PROTOCOL_ERROR',
      })
    );
  });

  it('previews a processor through the shared response schema', async () => {
    vi.stubEnv('VITE_BATCH_LAB_API_URL', 'http://test');
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe('http://test/api/batch-lab/processors/preview');
      expect(init?.method).toBe('POST');
      expect(JSON.parse(String(init?.body))).toEqual({
        config: { protocol: 'none_v1' },
        input_text: 'hello',
      });
      return new Response(
        JSON.stringify({
          success: true,
          data: {
            id: '35d2159d-dcea-46e9-aab2-8c68bd14e307',
            processor_version_id: '87fce0db-a75e-45b7-87be-b8e7edc8ae8f',
            processor_digest: `sha256:${'a'.repeat(64)}`,
            status: 'success',
            match_count: 0,
            input_text: 'hello',
            output_text: 'hello',
            sanitized_html: 'hello',
            error_code: null,
            renderer: { protocol: 'batch_lab_html_v1', version: 1 },
            created_at: '2026-09-11T06:00:00.000Z',
          },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      previewBatchLabProcessor({ config: { protocol: 'none_v1' }, input_text: 'hello' }, undefined)
    ).resolves.toMatchObject({ status: 'success', output_text: 'hello' });
  });

  it('creates an experiment through the shared response schema', async () => {
    vi.stubEnv('VITE_BATCH_LAB_API_URL', 'http://test');
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe('http://test/api/batch-lab/experiments');
      expect(init?.method).toBe('POST');
      const body = JSON.parse(String(init?.body));
      expect(body.variants).toHaveLength(2);
      return new Response(
        JSON.stringify({
          success: true,
          data: {
            id: '35d2159d-dcea-46e9-aab2-8c68bd14e307',
            name: 'experiment',
            sample_set_id: '87fce0db-a75e-45b7-87be-b8e7edc8ae8f',
            source_environment: 'test',
            status: 'draft',
            variants: body.variants,
            total_attempts: 0,
            completed_attempts: 0,
            failed_attempts: 0,
            created_at: '2026-09-11T06:00:00.000Z',
            started_at: null,
            completed_at: null,
          },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      createBatchLabExperiment({
        name: 'experiment',
        sample_set_id: '87fce0db-a75e-45b7-87be-b8e7edc8ae8f',
        source_environment: 'test',
        idempotency_key: 'd5e7e560-6f51-4be1-bcf0-745652088fa2',
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
            tier: 'premium',
            is_free: false,
            sampling: {},
            processor_version_id: null,
            max_turns: 1,
          },
        ],
      })
    ).resolves.toMatchObject({ status: 'draft' });
  });

  it('copies an experiment through the lineage endpoint', async () => {
    vi.stubEnv('VITE_BATCH_LAB_API_URL', 'http://test');
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe(
        'http://test/api/batch-lab/experiments/35d2159d-dcea-46e9-aab2-8c68bd14e307/copy'
      );
      expect(init?.method).toBe('POST');
      return new Response(
        JSON.stringify({
          success: true,
          data: {
            id: '26d2159d-dcea-46e9-aab2-8c68bd14e307',
            name: 'copy',
            sample_set_id: '87fce0db-a75e-45b7-87be-b8e7edc8ae8f',
            source_environment: 'test',
            status: 'draft',
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
            total_attempts: 0,
            completed_attempts: 0,
            failed_attempts: 0,
            created_at: '2026-09-11T06:00:00.000Z',
            started_at: null,
            completed_at: null,
          },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      copyBatchLabExperiment({
        source_experiment_id: '35d2159d-dcea-46e9-aab2-8c68bd14e307',
        name: 'copy',
        source_environment: 'test',
        idempotency_key: 'd5e7e560-6f51-4be1-bcf0-745652088fa2',
      })
    ).resolves.toMatchObject({ name: 'copy', status: 'draft' });
  });

  it('downloads experiment JSONL as a blob', async () => {
    vi.stubEnv('VITE_BATCH_LAB_API_URL', 'http://test');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('{"schema_version":"batch_lab_jsonl_v1"}\n', { status: 200 }))
    );
    const blob = await downloadBatchLabExperimentJsonl('35d2159d-dcea-46e9-aab2-8c68bd14e307');
    await expect(blob.text()).resolves.toContain('batch_lab_jsonl_v1');
  });

  it('runs a worker batch only for the selected experiment', async () => {
    vi.stubEnv('VITE_BATCH_LAB_API_URL', 'http://test');
    const experimentId = '35d2159d-dcea-46e9-aab2-8c68bd14e307';
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe(`http://test/api/batch-lab/experiments/${experimentId}/worker/run-once`);
      expect(init?.method).toBe('POST');
      expect(JSON.parse(String(init?.body))).toMatchObject({
        experiment_id: experimentId,
        worker_id: 'batch-lab-ui-test',
        claim_limit: 1,
      });
      return new Response(
        JSON.stringify({
          success: true,
          data: { claimed_count: 1, completed_count: 1, failed_count: 0 },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      runBatchLabExperimentWorkerOnce({
        experiment_id: experimentId,
        source_environment: 'test',
        worker_id: 'batch-lab-ui-test',
        claim_limit: 1,
      })
    ).resolves.toEqual({ claimed_count: 1, completed_count: 1, failed_count: 0 });
  });

  it('stops and deletes the selected experiment through control endpoints', async () => {
    vi.stubEnv('VITE_BATCH_LAB_API_URL', 'http://test');
    const experimentId = '35d2159d-dcea-46e9-aab2-8c68bd14e307';
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === 'POST') {
        expect(url).toBe(`http://test/api/batch-lab/experiments/${experimentId}/stop`);
        return new Response(
          JSON.stringify({
            success: true,
            data: {
              id: experimentId,
              name: 'experiment',
              sample_set_id: '87fce0db-a75e-45b7-87be-b8e7edc8ae8f',
              source_environment: 'test',
              status: 'cancelled',
              variants: [
                {
                  key: 'a',
                  name: 'A',
                  model_id: 'a',
                  openrouter_model_id: 'a',
                  tier: null,
                  is_free: false,
                  sampling: {},
                  processor_version_id: null,
                  max_turns: 1,
                },
                {
                  key: 'b',
                  name: 'B',
                  model_id: 'b',
                  openrouter_model_id: 'b',
                  tier: null,
                  is_free: false,
                  sampling: {},
                  processor_version_id: null,
                  max_turns: 1,
                },
              ],
              total_attempts: 2,
              completed_attempts: 0,
              failed_attempts: 0,
              created_at: '2026-09-17T06:00:00.000Z',
              started_at: '2026-09-17T06:01:00.000Z',
              completed_at: '2026-09-17T06:02:00.000Z',
            },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }
      expect(url).toBe(`http://test/api/batch-lab/experiments/${experimentId}`);
      expect(init?.method).toBe('DELETE');
      return new Response(
        JSON.stringify({
          success: true,
          data: { id: experimentId, deleted_at: '2026-09-17T06:03:00.000Z' },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      stopBatchLabExperiment({ experiment_id: experimentId, source_environment: 'test' })
    ).resolves.toMatchObject({ status: 'cancelled' });
    await expect(
      deleteBatchLabExperiment({ experiment_id: experimentId, source_environment: 'test' })
    ).resolves.toMatchObject({ id: experimentId });
  });
});
