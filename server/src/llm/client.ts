/**
 * Talks to llama-swap (or llama-server in router mode) over its OpenAI-compatible API.
 * The model server listens on localhost only; this client is the only thing that calls it.
 */

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ChatOptions {
  model: string;
  messages: ChatMessage[];
  temperature?: number;
  max_tokens?: number;
  /** Ask the server to skip reasoning for quick answers (chat-template dependent). */
  reasoning?: boolean;
  signal?: AbortSignal;
}

export interface ChatResult {
  content: string;
  prompt_tokens: number;
  completion_tokens: number;
  duration_ms: number;
}

interface StreamEvent {
  choices?: { delta?: { content?: string } }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

export class LlmError extends Error {}

export class LlmClient {
  constructor(
    public baseUrl: string,
    private timeoutMs = 30 * 60_000,
  ) {}

  private url(path: string): string {
    return `${this.baseUrl.replace(/\/+$/, "")}${path}`;
  }

  /** Streams internally: Node's fetch gives up after 5 minutes without response headers. */
  async chat(o: ChatOptions): Promise<ChatResult> {
    const t0 = Date.now();
    let content = "";
    let usage: StreamEvent["usage"];
    for await (const j of this.events(o)) {
      content += j.choices?.[0]?.delta?.content ?? "";
      usage = j.usage ?? usage;
    }
    return {
      content: stripThinking(content),
      prompt_tokens: usage?.prompt_tokens ?? 0,
      completion_tokens: usage?.completion_tokens ?? 0,
      duration_ms: Date.now() - t0,
    };
  }

  /** Streams content deltas; yields strings. */
  async *chatStream(o: ChatOptions): AsyncGenerator<string> {
    for await (const j of this.events(o)) {
      const d = j.choices?.[0]?.delta?.content;
      if (d) yield d;
    }
  }

  private async *events(o: ChatOptions): AsyncGenerator<StreamEvent> {
    const body: Record<string, unknown> = {
      model: o.model,
      messages: o.messages,
      temperature: o.temperature ?? 0.2,
      stream: true,
      stream_options: { include_usage: true },
    };
    if (o.max_tokens) body.max_tokens = o.max_tokens;
    if (o.reasoning === false) body.chat_template_kwargs = { enable_thinking: false };
    const res = await fetch(this.url("/v1/chat/completions"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: o.signal ?? AbortSignal.timeout(this.timeoutMs),
    }).catch((e: Error) => {
      throw new LlmError(`model server unreachable at ${this.baseUrl}: ${e.message}`);
    });
    if (!res.ok || !res.body) throw new LlmError(`model server returned ${res.status}: ${(await res.text()).slice(0, 500)}`);
    const decoder = new TextDecoder();
    let buf = "";
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      buf += decoder.decode(chunk, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (data === "[DONE]") return;
        let j: StreamEvent;
        try {
          j = JSON.parse(data) as StreamEvent;
        } catch {
          // ignore keep-alives and partial lines
          continue;
        }
        yield j;
      }
    }
  }

  async embed(model: string, inputs: string[]): Promise<number[][]> {
    const res = await fetch(this.url("/v1/embeddings"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model, input: inputs }),
      signal: AbortSignal.timeout(5 * 60_000),
    });
    if (!res.ok) throw new LlmError(`embeddings returned ${res.status}`);
    const j = (await res.json()) as { data: { embedding: number[]; index: number }[] };
    return j.data.sort((a, b) => a.index - b.index).map((d) => d.embedding);
  }

  /** Models the server knows about. */
  async models(): Promise<string[]> {
    const res = await fetch(this.url("/v1/models"), { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new LlmError(`models returned ${res.status}`);
    const j = (await res.json()) as { data?: { id: string }[] };
    return (j.data ?? []).map((m) => m.id);
  }

  /** Models currently loaded (llama-swap's /running); empty list if unsupported. */
  async running(): Promise<string[]> {
    try {
      const res = await fetch(this.url("/running"), { signal: AbortSignal.timeout(5_000) });
      if (!res.ok) return [];
      const j = (await res.json()) as { running?: { model: string; state?: string }[] };
      return (j.running ?? []).map((r) => r.model);
    } catch {
      return [];
    }
  }

  /** Unload everything (llama-swap); the next request loads the requested model. */
  async unloadAll(): Promise<void> {
    for (const path of ["/api/models/unload", "/unload"]) {
      try {
        const res = await fetch(this.url(path), { method: "POST", signal: AbortSignal.timeout(30_000) });
        if (res.ok) return;
      } catch {
        // try the next endpoint
      }
    }
  }

  async healthy(): Promise<boolean> {
    try {
      const res = await fetch(this.url("/health"), { signal: AbortSignal.timeout(5_000) });
      if (res.ok) return true;
      await this.models();
      return true;
    } catch {
      return false;
    }
  }
}

/** Some models emit <think>…</think> before the answer; keep only the answer. */
export function stripThinking(s: string): string {
  return s.replace(/<think>[\s\S]*?<\/think>\s*/g, "").trim();
}
