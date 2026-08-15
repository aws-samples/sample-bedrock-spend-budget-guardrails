import { describe, expect, it } from 'vitest';
import { canonicalProvider } from '../src/components/providerName';

describe('canonicalProvider — one vendor-cased label regardless of source', () => {
  it('collapses a stored vendor-cased provider and a model-id-derived one to the SAME string', () => {
    // The bug: refresher row stored "OpenAI"; override row had none so the id
    // was used. Both must resolve identically.
    expect(canonicalProvider('OpenAI', 'openai.gpt-oss-120b-1:0')).toBe('OpenAI');
    expect(canonicalProvider(undefined, 'openai.gpt-5.6-luna')).toBe('OpenAI');
    expect(canonicalProvider('openai', 'openai.gpt-5.4')).toBe('OpenAI');
  });

  it('maps the non-title-caseable + internal-caps vendors exactly', () => {
    expect(canonicalProvider(undefined, 'ai21.jamba-1-5-large-v1:0')).toBe('AI21 Labs');
    expect(canonicalProvider(undefined, 'nvidia.nemotron-super-3-120b')).toBe('NVIDIA');
    expect(canonicalProvider(undefined, 'mistral.mistral-large-3-675b-instruct')).toBe('Mistral AI');
    expect(canonicalProvider(undefined, 'stability.stable-image-ultra-v1:1')).toBe('Stability AI');
    expect(canonicalProvider(undefined, 'zai.glm-5')).toBe('Z.AI');
    expect(canonicalProvider(undefined, 'minimax.minimax-m2.5')).toBe('MiniMax');
    expect(canonicalProvider(undefined, 'deepseek.v3.2')).toBe('DeepSeek');
    expect(canonicalProvider(undefined, 'twelvelabs.marengo-embed-3-0-v1:0')).toBe('TwelveLabs');
  });

  it('maps both moonshot prefixes to one vendor', () => {
    expect(canonicalProvider(undefined, 'moonshot.kimi-k2-thinking')).toBe('Moonshot AI');
    expect(canonicalProvider(undefined, 'moonshotai.kimi-k2.5')).toBe('Moonshot AI');
  });

  it('strips a CRIS prefix and title-cases unknown vendors; Unknown for empty', () => {
    expect(canonicalProvider(undefined, 'us.openai.gpt-oss-120b-1:0')).toBe('OpenAI');
    expect(canonicalProvider(undefined, 'newvendor.some-model')).toBe('Newvendor');
    expect(canonicalProvider(undefined, '')).toBe('Unknown');
    expect(canonicalProvider('', '')).toBe('Unknown');
  });
});
