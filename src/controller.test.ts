import { describe, expect, it, vi } from "vitest";
import type { VallumClient } from "@liteeagle226/client";
import { createVallumController } from "./controller.js";

describe("createVallumController", () => {
  it("shares initialization and exposes readable readiness", async () => {
    const pending = deferred<VallumClient>();
    const createClient = vi.fn(() => pending.promise);
    const controller = createVallumController(
      { endpoint: "https://app.example" },
      { createClient, isBrowser: () => true },
    );
    const states: string[] = [];
    const unsubscribe = controller.subscribe((state) => states.push(state.status));

    const first = controller.initialize();
    const second = controller.initialize();
    expect(first).toBe(second);
    expect(controller.snapshot.status).toBe("loading");

    const client = fakeClient();
    pending.resolve(client);
    await expect(first).resolves.toBe(client);
    expect(createClient).toHaveBeenCalledOnce();
    expect(controller.snapshot.ready).toBe(true);
    expect(states.at(-1)).toBe("ready");
    unsubscribe();
  });

  it("surfaces an error and can retry", async () => {
    const client = fakeClient();
    const createClient = vi.fn()
      .mockRejectedValueOnce(new Error("admission denied"))
      .mockResolvedValueOnce(client);
    const controller = createVallumController(
      { endpoint: "https://app.example", autoStart: false },
      { createClient, isBrowser: () => true },
    );

    await expect(controller.initialize()).rejects.toThrow("admission denied");
    expect(controller.snapshot.status).toBe("error");
    expect(controller.snapshot.error?.message).toBe("admission denied");

    await expect(controller.retry()).resolves.toBe(client);
    expect(controller.snapshot.status).toBe("ready");
    expect(controller.snapshot.error).toBeNull();
  });

  it("delegates protected fetch and releases the client on dispose", async () => {
    const client = fakeClient();
    const controller = createVallumController(
      { endpoint: "https://app.example", autoStart: false },
      { createClient: async () => client, isBrowser: () => true },
    );

    await controller.fetch("/api/private");
    expect(client.fetch).toHaveBeenCalledWith("/api/private", undefined);

    controller.dispose();
    expect(client.destroy).toHaveBeenCalledOnce();
    expect(controller.snapshot.status).toBe("disposed");
    await expect(controller.fetch("/api/private")).rejects.toThrow("disposed");
  });

  it("is inert during SSR and gives an explicit hydration error", async () => {
    const createClient = vi.fn(async () => fakeClient());
    const controller = createVallumController(
      { endpoint: "https://app.example" },
      { createClient, isBrowser: () => false },
    );

    expect(controller.snapshot.status).toBe("idle");
    expect(createClient).not.toHaveBeenCalled();
    await expect(controller.initialize()).rejects.toThrow("after hydration");
  });

  it("reports subscriber errors without losing or leaking the client", async () => {
    const reportError = vi.fn();
    vi.stubGlobal("reportError", reportError);
    const client = fakeClient();
    const controller = createVallumController(
      { endpoint: "https://app.example", autoStart: false },
      { createClient: async () => client, isBrowser: () => true },
    );
    controller.subscribe((state) => {
      if (state.status === "ready" || state.status === "disposed") throw new Error(`observer ${state.status}`);
    });

    await expect(controller.initialize()).resolves.toBe(client);
    expect(controller.snapshot.status).toBe("ready");
    controller.dispose();
    expect(client.destroy).toHaveBeenCalledOnce();
    await Promise.resolve();

    expect(reportError).toHaveBeenCalledTimes(2);
    vi.unstubAllGlobals();
  });
});

function fakeClient(): VallumClient & { destroy: ReturnType<typeof vi.fn> } {
  const destroy = vi.fn();
  return {
    fetch: vi.fn(async () => new Response("{}", {
      headers: { "Content-Type": "application/json" },
    })),
    wrapFetch: vi.fn((implementation: typeof globalThis.fetch) => implementation),
    renew: vi.fn(async () => undefined),
    mount: vi.fn(async () => false),
    isRenderOnly: vi.fn(() => false),
    destroy,
  } as unknown as VallumClient & { destroy: ReturnType<typeof vi.fn> };
}

function deferred<T>(): {
  readonly promise: Promise<T>;
  resolve(value: T): void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((fulfill) => {
    resolve = fulfill;
  });
  return { promise, resolve };
}
