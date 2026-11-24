import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { Platform } from "../src/core/schemas.js";
import { loadModels } from "../src/core/load.js";
import { llamaSwapConfig } from "../src/swapconfig.js";
import { tempWorkspace } from "./helpers.js";

describe("llama-swap config", () => {
  it("keeps MoE experts on the CPU on Linux until tuned, quotes paths, and groups models", () => {
    tempWorkspace();
    process.env.OPENHELPER_MODELS = "/home/me/My Models";
    try {
      const desktop = Platform.parse({
        name: "desktop",
        url: "http://127.0.0.1:8740",
        os: "linux",
        model: { current: "qwen3.6-35b-a3b-q4km", light: "qwen3-8b-q4km", embed: "qwen3-embedding-0.6b-q8", allowed: ["qwen3.6-35b-a3b-q4km", "qwen3-8b-q4km"] },
      });
      const doc = parse(llamaSwapConfig(desktop, loadModels(), "/opt/llama/llama-server")) as {
        models: Record<string, { cmd: string; ttl: number }>;
        groups: Record<string, { members: string[]; persistent?: boolean }>;
      };
      expect(Object.keys(doc.models).sort()).toEqual(["qwen3-8b-q4km", "qwen3-embedding-0.6b-q8", "qwen3.6-35b-a3b-q4km"]);
      const moe = doc.models["qwen3.6-35b-a3b-q4km"]!.cmd;
      expect(moe).toContain("--cpu-moe");
      expect(moe).toContain("--host 127.0.0.1");
      expect(moe).toContain("-m '/home/me/My Models/qwen3.6-35b-a3b-q4km.gguf'");
      expect(doc.models["qwen3-8b-q4km"]!.cmd).not.toContain("--cpu-moe");
      expect(doc.groups.chat!.members.sort()).toEqual(["qwen3-8b-q4km", "qwen3.6-35b-a3b-q4km"]);
      expect(doc.groups.embed).toMatchObject({ members: ["qwen3-embedding-0.6b-q8"], persistent: true });

      const tuned = Platform.parse({ ...desktop, model_overrides: { "qwen3.6-35b-a3b-q4km": { n_cpu_moe: 20 } } });
      expect(parse(llamaSwapConfig(tuned, loadModels(), "/x")).models["qwen3.6-35b-a3b-q4km"].cmd).toContain("--n-cpu-moe 20");

      const mac = Platform.parse({ ...desktop, name: "mac", os: "macos" });
      expect(parse(llamaSwapConfig(mac, loadModels(), "/x")).models["qwen3.6-35b-a3b-q4km"].cmd).not.toContain("cpu-moe");
    } finally {
      delete process.env.OPENHELPER_MODELS;
    }
  });
});
