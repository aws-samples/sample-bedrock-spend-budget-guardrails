/**
 * Static map from the human-readable `model` attribute in the AmazonBedrock
 * service code (e.g. `Nova Micro`) to the canonical Bedrock modelId
 * (e.g. `amazon.nova-micro-v1:0`).
 *
 * Required because:
 *   1. AmazonBedrock SKUs only carry `model: "Nova Micro"`, not the
 *      modelId we need to key Pricing rows on.
 *   2. `bedrock:ListFoundationModels` returns Nova models, but their
 *      `modelName` ("Amazon Nova Micro") doesn't always match the
 *      Pricing API's `model` value ("Nova Micro") cleanly.
 *
 * If a new Nova model appears in either source that's not in this map,
 * the refresher emits a `bbg.PricingMapMissing` metric and the model is
 * surfaced on the Pricing Overrides UI page.
 */
export const NOVA_MODEL_NAME_TO_ID: Record<string, string> = {
  'Nova Micro': 'amazon.nova-micro-v1:0',
  'Nova Lite': 'amazon.nova-lite-v1:0',
  'Nova Pro': 'amazon.nova-pro-v1:0',
  'Nova Premier': 'amazon.nova-premier-v1:0',
  'Nova Canvas': 'amazon.nova-canvas-v1:0',
  'Nova Reel': 'amazon.nova-reel-v1:0',
  'Nova Sonic': 'amazon.nova-sonic-v1:0',
};

export const novaModelIdFor = (modelName: string): string | undefined =>
  NOVA_MODEL_NAME_TO_ID[modelName];
