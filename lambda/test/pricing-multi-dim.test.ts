import { describe, expect, it } from 'vitest';
import { computeCost, dimensionsOf, type PricingRow } from '../src/shared/pricing.js';

describe('multi-dim pricing', () => {
  describe('dimensionsOf', () => {
    it('synthesizes dimensions from legacy inputPer1k/outputPer1k', () => {
      const row: PricingRow = { inputPer1k: 0.003, outputPer1k: 0.015 };
      const dims = dimensionsOf(row, 'us-east-1');
      expect(dims.inputTokens?.pricePerUnit).toBe(0.003);
      expect(dims.outputTokens?.pricePerUnit).toBe(0.015);
      expect(dims.outputImages).toBeUndefined();
    });

    it('prefers regionDimensions over top-level dimensions', () => {
      const row: PricingRow = {
        dimensions: {
          inputTokens: { unit: '1K tokens', pricePerUnit: 0.003 },
        },
        regionDimensions: {
          'eu-west-1': { inputTokens: { unit: '1K tokens', pricePerUnit: 0.0033 } },
        },
      };
      expect(dimensionsOf(row, 'eu-west-1').inputTokens?.pricePerUnit).toBe(0.0033);
      expect(dimensionsOf(row, 'us-east-1').inputTokens?.pricePerUnit).toBe(0.003);
    });

    it('explicit dimensions take precedence over legacy fields', () => {
      const row: PricingRow = {
        inputPer1k: 0.001, // legacy
        dimensions: { inputTokens: { unit: '1K tokens', pricePerUnit: 0.003 } },
      };
      expect(dimensionsOf(row, 'us-east-1').inputTokens?.pricePerUnit).toBe(0.003);
    });
  });

  describe('computeCost - token models', () => {
    it('Sonnet 4.6: 1M input + 500K output ≈ $10.50', () => {
      const r = computeCost(
        { inputPer1k: 0.003, outputPer1k: 0.015 },
        'us-east-1',
        { inputTokens: 1_000_000, outputTokens: 500_000 },
      );
      expect(r.priced).toBe(true);
      expect(r.spendUsd).toBeCloseTo(0.003 * 1000 + 0.015 * 500, 4);
      expect(r.dimensionsCost.inputTokens).toBeCloseTo(3.0, 4);
      expect(r.dimensionsCost.outputTokens).toBeCloseTo(7.5, 4);
    });

    it('cache read + write contribute to the bill', () => {
      const r = computeCost(
        {
          inputPer1k: 0.003,
          outputPer1k: 0.015,
          cacheReadPer1k: 0.0003, // 10% of input
          cacheWritePer1k: 0.00375, // 1.25× input
        },
        'us-east-1',
        {
          inputTokens: 100,
          outputTokens: 100,
          cacheReadTokens: 1000,
          cacheWriteTokens: 1000,
        },
      );
      expect(r.priced).toBe(true);
      expect(r.dimensionsCost.cacheReadTokens).toBeCloseTo(0.0003, 6);
      expect(r.dimensionsCost.cacheWriteTokens).toBeCloseTo(0.00375, 6);
    });
  });

  describe('computeCost - image models', () => {
    it('Stable Diffusion: 4 images @ $0.08 = $0.32', () => {
      const r = computeCost(
        {
          dimensions: {
            outputImages: { unit: 'image', pricePerUnit: 0.08, label: '1024×1024 image' },
          },
        },
        'us-east-1',
        { outputImages: 4 },
      );
      expect(r.priced).toBe(true);
      expect(r.spendUsd).toBeCloseTo(0.32, 4);
      expect(r.dimensionsCost.outputImages).toBeCloseTo(0.32, 4);
    });
  });

  describe('computeCost - rerank models', () => {
    it('Cohere Rerank: 5 search units @ $0.001 = $0.005', () => {
      const r = computeCost(
        {
          dimensions: {
            searchUnits: { unit: 'search unit', pricePerUnit: 0.001 },
          },
        },
        'us-east-1',
        { searchUnits: 5 },
      );
      expect(r.priced).toBe(true);
      expect(r.spendUsd).toBeCloseTo(0.005, 6);
    });
  });

  describe('computeCost - video / audio models', () => {
    it('Luma Ray: 6 video-output-seconds @ $0.40/s = $2.40', () => {
      const r = computeCost(
        {
          dimensions: {
            outputVideoSeconds: { unit: 'second', pricePerUnit: 0.40 },
          },
        },
        'us-east-1',
        { outputVideoSeconds: 6 },
      );
      expect(r.priced).toBe(true);
      expect(r.spendUsd).toBeCloseTo(2.40, 4);
    });

    it('Nova Sonic: 30 input + 10 output audio seconds, asymmetric pricing', () => {
      const r = computeCost(
        {
          dimensions: {
            inputAudioSeconds: { unit: 'second', pricePerUnit: 0.0001 },
            outputAudioSeconds: { unit: 'second', pricePerUnit: 0.0008 },
          },
        },
        'us-east-1',
        { inputAudioSeconds: 30, outputAudioSeconds: 10 },
      );
      expect(r.priced).toBe(true);
      expect(r.dimensionsCost.inputAudioSeconds).toBeCloseTo(0.003, 6);
      expect(r.dimensionsCost.outputAudioSeconds).toBeCloseTo(0.008, 6);
      expect(r.spendUsd).toBeCloseTo(0.011, 6);
    });
  });

  describe('computeCost - mixed-modality models', () => {
    it('Nova Lite: 1k input tokens + 1 image rolls up into a single spend', () => {
      const r = computeCost(
        {
          dimensions: {
            inputTokens: { unit: '1K tokens', pricePerUnit: 0.00006 },
            outputTokens: { unit: '1K tokens', pricePerUnit: 0.00024 },
            outputImages: { unit: 'image', pricePerUnit: 0.04 },
          },
        },
        'us-east-1',
        { inputTokens: 1000, outputTokens: 500, outputImages: 1 },
      );
      expect(r.priced).toBe(true);
      expect(r.dimensionsCost.inputTokens).toBeCloseTo(0.00006, 8);
      expect(r.dimensionsCost.outputTokens).toBeCloseTo(0.00012, 8);
      expect(r.dimensionsCost.outputImages).toBeCloseTo(0.04, 6);
      expect(r.spendUsd).toBeCloseTo(0.04018, 5);
    });
  });

  describe('computeCost - unpriced edges', () => {
    it('flags unpriced when pricing row is missing entirely', () => {
      const r = computeCost(undefined, 'us-east-1', { inputTokens: 100 });
      expect(r.priced).toBe(false);
      expect(r.spendUsd).toBe(0);
    });

    it('flags unpriced when usage is non-zero but the dim is missing', () => {
      const r = computeCost(
        { dimensions: { inputTokens: { unit: '1K tokens', pricePerUnit: 0.003 } } },
        'us-east-1',
        { outputImages: 4 }, // no outputImages dim => unpriced
      );
      expect(r.priced).toBe(false);
      expect(r.spendUsd).toBe(0);
      expect(r.dimensionsUsage.outputImages).toBe(4);
    });

    it('returns priced=false when no usage was reported', () => {
      const r = computeCost(
        { inputPer1k: 0.003, outputPer1k: 0.015 },
        'us-east-1',
        {},
      );
      expect(r.priced).toBe(false);
      expect(r.spendUsd).toBe(0);
    });
  });

  describe('custom pricing discount', () => {
    const pricing = { inputPer1k: 0.003, outputPer1k: 0.015 };
    const usage = { inputTokens: 1_000_000, outputTokens: 500_000 }; // list = $10.50

    it('scales total AND every dimension cost by (1 - pct/100)', () => {
      const r = computeCost(pricing, 'us-east-1', usage, 25);
      expect(r.spendUsd).toBeCloseTo(10.5 * 0.75, 4); // 7.875
      expect(r.dimensionsCost.inputTokens).toBeCloseTo(3.0 * 0.75, 4);
      expect(r.dimensionsCost.outputTokens).toBeCloseTo(7.5 * 0.75, 4);
      expect(r.priced).toBe(true);
    });

    it('undefined discount == list price (unchanged)', () => {
      const r = computeCost(pricing, 'us-east-1', usage);
      expect(r.spendUsd).toBeCloseTo(10.5, 4);
    });

    it('0% discount == list price', () => {
      expect(computeCost(pricing, 'us-east-1', usage, 0).spendUsd).toBeCloseTo(10.5, 4);
    });

    it('100% discount zeroes spend but stays priced (no false UnpricedInvocations)', () => {
      const r = computeCost(pricing, 'us-east-1', usage, 100);
      expect(r.spendUsd).toBe(0);
      expect(r.priced).toBe(true); // model HAD rates — not "unpriced"
    });

    it('clamps out-of-range discounts (negative → list, >100 → free)', () => {
      expect(computeCost(pricing, 'us-east-1', usage, -10).spendUsd).toBeCloseTo(10.5, 4);
      expect(computeCost(pricing, 'us-east-1', usage, 150).spendUsd).toBe(0);
    });
  });
});
