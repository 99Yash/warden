import {
  type EmbedInputType,
  type EmbedRequest,
  type EmbedResponse,
  type EmbeddingProvider,
} from "./interfaces.js";
import { VOYAGE_MAX_BATCH_SIZE, voyageModelMeta } from "./voyage-models.js";

/**
 * Voyage `voyage-code-3` provider for M6 (ADR-0019 #1). Direct REST call
 * via Node's native `fetch` — voyageai 0.2.1's ESM build was broken at
 * adoption time (mis-pathed `.jsx` imports), so we use the documented
 * HTTP API directly. The client surface stays small enough that this is
 * cheaper than carrying the SDK's bug surface, and the resilience policy
 * mirrors the LLM cascade's posture (ADR-0017).
 *
 * Resilience: retry once on transient (HTTP 429 / 5xx / network) with 1 s
 * backoff, escalating to ≤3 attempts total, then hard fail. Hard errors
 * (auth, malformed response after schema validation) bypass retry.
 */

const RETRY_BACKOFF_MS = 1000;
const MAX_RETRIES = 3;
const VOYAGE_ENDPOINT = "https://api.voyageai.com/v1/embeddings";

export interface VoyageProviderOptions {
  apiKey: string;
  /** Override model id (mostly for tests / ADR-bumps mid-flight). */
  modelId?: string;
  /** Override endpoint — useful for replay tests. */
  endpoint?: string;
  /** Hard timeout per attempt (ms). */
  timeoutMs?: number;
}

interface VoyageEmbedResponseShape {
  object?: string;
  data?: { object?: string; embedding?: number[]; index?: number }[];
  model?: string;
  usage?: { total_tokens?: number };
}

class VoyageHttpError extends Error {
  readonly statusCode: number;
  constructor(statusCode: number, message: string) {
    super(message);
    this.statusCode = statusCode;
  }
}

export class VoyageProvider implements EmbeddingProvider {
  private readonly apiKey: string;
  private readonly _modelId: string;
  private readonly endpoint: string;
  private readonly timeoutMs: number;

  constructor(opts: VoyageProviderOptions) {
    this.apiKey = opts.apiKey;
    this._modelId = opts.modelId ?? "voyage-code-3";
    this.endpoint = opts.endpoint ?? VOYAGE_ENDPOINT;
    this.timeoutMs = opts.timeoutMs ?? 60_000;
  }

  modelId(): string {
    return this._modelId;
  }

  modelVersion(inputType: EmbedInputType): string {
    const meta = voyageModelMeta(this._modelId);
    return `dim=${meta.outputDim};type=${inputType}`;
  }

  maxBatchSize(): number {
    return VOYAGE_MAX_BATCH_SIZE;
  }

  maxInputTokens(): number {
    return voyageModelMeta(this._modelId).maxInputTokens;
  }

  async embed(req: EmbedRequest): Promise<EmbedResponse> {
    if (req.inputs.length === 0) {
      return {
        vectors: [],
        modelId: this._modelId,
        modelVersion: this.modelVersion(req.inputType),
        promptTokens: 0,
      };
    }
    if (req.inputs.length > this.maxBatchSize()) {
      throw new Error(
        `VoyageProvider.embed received ${req.inputs.length} inputs; max batch size is ${this.maxBatchSize()}`,
      );
    }

    let lastError: unknown;
    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      try {
        const response = await this.fetchOnce(req);
        return response;
      } catch (err) {
        lastError = err;
        if (!isTransient(err) || attempt === MAX_RETRIES - 1) break;
        await sleep(RETRY_BACKOFF_MS * (attempt + 1));
      }
    }
    throw new Error(
      `VoyageProvider.embed failed after ${MAX_RETRIES} attempts: ${formatError(lastError)}`,
    );
  }

  private async fetchOnce(req: EmbedRequest): Promise<EmbedResponse> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let response: Response;
    try {
      response = await fetch(this.endpoint, {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.apiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: this._modelId,
          input: req.inputs,
          input_type: req.inputType,
          output_dtype: "float",
          truncation: true,
        }),
        signal: controller.signal,
      });
    } catch (err) {
      throw err;
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new VoyageHttpError(
        response.status,
        `Voyage HTTP ${response.status}: ${text.slice(0, 200)}`,
      );
    }

    const json = (await response.json()) as VoyageEmbedResponseShape;
    const data = json.data ?? [];
    const vectors: Float32Array[] = Array.from({ length: req.inputs.length });
    for (const item of data) {
      if (typeof item.index !== "number" || !Array.isArray(item.embedding)) {
        throw new Error(
          "VoyageProvider: malformed response — embedding item missing index/embedding",
        );
      }
      vectors[item.index] = Float32Array.from(item.embedding);
    }
    for (let i = 0; i < vectors.length; i++) {
      if (!vectors[i]) {
        throw new Error(`VoyageProvider: response missing embedding for input index ${i}`);
      }
    }
    return {
      vectors,
      modelId: this._modelId,
      modelVersion: this.modelVersion(req.inputType),
      promptTokens: json.usage?.total_tokens ?? 0,
    };
  }
}

function isTransient(err: unknown): boolean {
  if (err instanceof VoyageHttpError) {
    if (err.statusCode === 429) return true;
    if (err.statusCode >= 500 && err.statusCode < 600) return true;
    return false;
  }
  if (err instanceof Error) {
    if (/abort|timeout|network|fetch failed/i.test(err.message)) return true;
  }
  const code = errorCode(err);
  if (code === "ETIMEDOUT" || code === "ECONNRESET" || code === "ECONNREFUSED" || code === "ENETUNREACH") {
    return true;
  }
  return false;
}

function errorCode(err: unknown): string | undefined {
  if (err && typeof err === "object" && "code" in err) {
    const v = (err as { code?: unknown }).code;
    return typeof v === "string" ? v : undefined;
  }
  return undefined;
}

function formatError(err: unknown): string {
  if (err instanceof Error) return err.message.slice(0, 160);
  return String(err).slice(0, 160);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
