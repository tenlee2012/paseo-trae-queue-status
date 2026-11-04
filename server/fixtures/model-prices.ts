import { ModelPriceCatalog, parseModelPrices } from "../model-pricing.js";

// Synthetic Models.dev response: tests never fetch live rates or read user logs.
export const modelPrices = {
  openai: {
    models: {
      "fixture-model-a": {
        name: "Fixture Model A",
        canonical_model_id: "openai/fixture-model-a",
        cost: {
          input: 2,
          output: 10,
          cache_read: 0.1,
          cache_write: 2.5,
          tiers: [
            {
              input: 4,
              output: 15,
              cache_read: 0.2,
              cache_write: 5,
              tier: { type: "context", size: 272_000 },
            },
          ],
          context_over_200k: { input: 4, output: 15, cache_read: 0.2, cache_write: 5 },
        },
      },
    },
  },
  example: {
    models: {
      "test-model": { cost: { input: 3, output: 15, cache_read: 0.3, cache_write: 3.75 } },
    },
  },
  deepseek: {
    models: {
      "deepseek-flash": {
        name: "DeepSeek V4.1 Flash 1017",
        canonical_model_id: "deepseek/deepseek-v4.1-flash-1017",
        cost: { input: 0.15, output: 0.6, cache_read: 0.003 },
      },
      "deepseek-v4-flash": {
        name: "DeepSeek V4 Flash",
        canonical_model_id: "deepseek/deepseek-v4.1-flash-1017",
        cost: { input: 0.15, output: 0.6, cache_read: 0.003 },
      },
      "deepseek-v4-pro": {
        name: "DeepSeek V4 Pro",
        canonical_model_id: "deepseek/deepseek-v4-pro-0813",
        cost: { input: 0.66, output: 1.98, cache_read: 0.022 },
      },
    },
  },
};
export const testPrices = new ModelPriceCatalog(parseModelPrices(modelPrices));
export const testPricing = { getCatalog: async () => testPrices };
