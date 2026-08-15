import { describe, expect, it } from 'vitest';
import { providerFromModelId } from '../src/shared/provider';

describe('providerFromModelId — canonical vendor casing from model id', () => {
  it('maps the tricky non-title-caseable providers exactly', () => {
    expect(providerFromModelId('openai.gpt-5.6-luna')).toBe('OpenAI');
    expect(providerFromModelId('openai.gpt-oss-120b-1:0')).toBe('OpenAI');
    expect(providerFromModelId('ai21.jamba-1-5-large-v1:0')).toBe('AI21 Labs');
    expect(providerFromModelId('nvidia.nemotron-super-3-120b')).toBe('NVIDIA');
    expect(providerFromModelId('mistral.mistral-large-3-675b-instruct')).toBe('Mistral AI');
    expect(providerFromModelId('stability.stable-image-ultra-v1:1')).toBe('Stability AI');
    expect(providerFromModelId('luma.ray-v2:0')).toBe('Luma AI');
    expect(providerFromModelId('deepseek.v3.2')).toBe('DeepSeek');
    expect(providerFromModelId('minimax.minimax-m2.5')).toBe('MiniMax');
    expect(providerFromModelId('twelvelabs.marengo-embed-3-0-v1:0')).toBe('TwelveLabs');
  });

  it('handles zai (dot in the display name) without splitting on it', () => {
    expect(providerFromModelId('zai.glm-5')).toBe('Z.AI');
  });

  it('maps BOTH moonshot prefixes to one vendor', () => {
    expect(providerFromModelId('moonshot.kimi-k2-thinking')).toBe('Moonshot AI');
    expect(providerFromModelId('moonshotai.kimi-k2.5')).toBe('Moonshot AI');
  });

  it('groups gpt-oss and gemma under their real vendors (openai / google)', () => {
    expect(providerFromModelId('openai.gpt-oss-20b-1:0')).toBe('OpenAI');
    expect(providerFromModelId('google.gemma-3-27b-it')).toBe('Google');
  });

  it('strips a CRIS regional prefix before mapping', () => {
    expect(providerFromModelId('us.openai.gpt-oss-120b-1:0')).toBe('OpenAI');
    expect(providerFromModelId('eu.anthropic.claude-opus-4-6-v1')).toBe('Anthropic');
  });

  it('title-cases an unknown provider and returns Unknown for empty', () => {
    expect(providerFromModelId('newvendor.some-model')).toBe('Newvendor');
    expect(providerFromModelId('')).toBe('Unknown');
  });
});
