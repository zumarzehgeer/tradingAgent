import { promises as fs } from "fs";
import path from "path";
import { ModelGate } from "./backtest/engine";

interface SerializedModel {
  featureNames: string[];
  weights: number[];
  means: number[];
  stds: number[];
  threshold: number;
  trainedAt: string;
  trainPeriod?: { start: string; splitAt: string };
}

// Load the logistic regression gate. Returns null if disabled or the file
// doesn't exist (gracefully degrades — bot just runs without the gate).
export async function loadModelGate(
  modelPath: string,
  thresholdOverride?: number
): Promise<ModelGate | null> {
  const abs = path.isAbsolute(modelPath) ? modelPath : path.resolve(modelPath);
  let raw: string;
  try {
    raw = await fs.readFile(abs, "utf-8");
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === "ENOENT") return null;
    throw err;
  }
  const model: SerializedModel = JSON.parse(raw);
  return {
    weights: model.weights,
    means: model.means,
    stds: model.stds,
    threshold: thresholdOverride ?? model.threshold,
  };
}

export function describeModelAge(model: { trainedAt?: string } | null): string {
  if (!model || !model.trainedAt) return "unknown";
  const ageMs = Date.now() - new Date(model.trainedAt).getTime();
  const days = Math.floor(ageMs / (1000 * 60 * 60 * 24));
  return `${days} days old`;
}
