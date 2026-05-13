// Run with: node check_models.mjs
import { readFileSync } from 'fs';

// Read .env manually
const env = readFileSync('.env', 'utf8');
const match = env.match(/GEMINI_API_KEY="?([^"\n]+)"?/);
const key = match?.[1];
if (!key) { console.error("No GEMINI_API_KEY found in .env"); process.exit(1); }

console.log("Checking available embedding models...\n");

const res = await fetch(`https://generativelanguage.googleapis.com/v1/models?key=${key}`);
const data = await res.json();

if (!data.models) {
  console.error("API Error:", JSON.stringify(data, null, 2));
  process.exit(1);
}

const embedModels = data.models.filter(m =>
  m.supportedGenerationMethods?.includes("embedContent") ||
  m.supportedGenerationMethods?.includes("batchEmbedContents")
);

if (embedModels.length === 0) {
  console.log("No embedding models found for this API key!");
  console.log("\nAll available models:");
  data.models.forEach(m => console.log(`  ${m.name} -> ${m.supportedGenerationMethods}`));
} else {
  console.log("Available embedding models:");
  embedModels.forEach(m => {
    console.log(`  ${m.name}`);
    console.log(`    Methods: ${m.supportedGenerationMethods.join(", ")}`);
  });
}
