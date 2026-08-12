import { describe, expect, it, vi } from "vitest";
import type { MountOptions, VallumClient } from "@liteeagle226/client";
import { createVallumController } from "./controller.js";
import {
  createVallumRenderAction,
  type VallumRenderActionParameters,
} from "./index.js";

describe("createVallumRenderAction", () => {
  it("starts the replacement immediately and never consumes or commits the stale paint", async () => {
    const first = renderValue("first", true);
    const second = renderValue("second");
    const client = fakeRenderClient();
    const controller = await readyController([client]);
    const host = fakeHost();
    const lifecycle = requireActionLifecycle(createVallumRenderAction(controller)(asElement(host), {
      value: first,
    }));

    await first.started.promise;
    const firstSignal = mountSignal(client, 0);
    lifecycle.update?.({ value: second });

    expect(firstSignal.aborted).toBe(true);
    await second.started.promise;
    await flushAsyncWork();
    expect(second.consumed).toBe(true);
    expect(host.firstChild?.id).toBe("second");

    first.gate?.resolve();
    await flushAsyncWork();
    expect(first.consumed).toBe(false);
    expect(host.firstChild?.id).toBe("second");

    lifecycle.destroy?.();
    controller.dispose();
  });

  it("aborts an in-flight paint on teardown without consuming or committing it", async () => {
    const value = renderValue("slow", true);
    const client = fakeRenderClient();
    const controller = await readyController([client]);
    const host = fakeHost();
    const lifecycle = requireActionLifecycle(createVallumRenderAction(controller)(asElement(host), {
      value,
    }));

    await value.started.promise;
    const signal = mountSignal(client, 0);
    lifecycle.destroy?.();

    expect(signal.aborted).toBe(true);
    expect(host.firstChild).toBeNull();
    value.gate?.resolve();
    await flushAsyncWork();
    expect(value.consumed).toBe(false);
    expect(host.firstChild).toBeNull();

    controller.dispose();
  });

  it("combines a caller abort signal with the action lifecycle signal", async () => {
    const value = renderValue("external-abort", true);
    const client = fakeRenderClient();
    const controller = await readyController([client]);
    const external = new AbortController();
    const reason = new Error("view was hidden");
    const onError = vi.fn();
    const lifecycle = requireActionLifecycle(createVallumRenderAction(controller)(asElement(fakeHost()), {
      value,
      options: { signal: external.signal },
      onError,
    }));

    await value.started.promise;
    const combined = mountSignal(client, 0);
    expect(combined).not.toBe(external.signal);
    external.abort(reason);
    expect(combined.aborted).toBe(true);
    expect(combined.reason).toBe(reason);

    value.gate?.resolve();
    await flushAsyncWork();
    expect(value.consumed).toBe(false);
    expect(onError).toHaveBeenCalledWith(reason);

    lifecycle.destroy?.();
    controller.dispose();
  });

  it("clears mounted pixels on replacement, client retry, and client disposal", async () => {
    const firstClient = fakeRenderClient();
    const secondClient = fakeRenderClient();
    const controller = await readyController([firstClient, secondClient]);
    const first = renderValue("first");
    const replacement = renderValue("replacement", true);
    const afterRetry = renderValue("after-retry");
    const errors = vi.fn();
    const host = fakeHost();
    const lifecycle = requireActionLifecycle(createVallumRenderAction(controller)(asElement(host), {
      value: first,
      onError: errors,
    }));

    await first.started.promise;
    await flushAsyncWork();
    expect(host.firstChild?.id).toBe("first");

    lifecycle.update?.({ value: replacement, onError: errors });
    expect(host.firstChild).toBeNull();
    await replacement.started.promise;
    replacement.gate?.resolve();
    await flushAsyncWork();
    expect(host.firstChild?.id).toBe("replacement");

    const retry = controller.retry();
    expect(host.firstChild).toBeNull();
    await retry;
    await flushAsyncWork();
    expect(replacement.consumed).toBe(true);
    expect(host.firstChild).toBeNull();
    expect(errors).toHaveBeenCalledOnce();
    expect(errors.mock.calls[0]?.[0]).toMatchObject({
      message: "Vallum render-only value could not be mounted",
    });

    lifecycle.update?.({ value: afterRetry, onError: errors });
    await afterRetry.started.promise;
    await flushAsyncWork();
    expect(host.firstChild?.id).toBe("after-retry");

    controller.dispose();
    expect(host.firstChild).toBeNull();
    expect(errors).toHaveBeenCalledOnce();
    lifecycle.destroy?.();
  });

  it("updates same-value presentation without remounting or re-consuming", async () => {
    const value = renderValue("same");
    const client = fakeRenderClient();
    const controller = await readyController([client]);
    const host = fakeHost();
    const lifecycle = requireActionLifecycle(createVallumRenderAction(controller)(asElement(host), {
      value,
      options: { height: 30, accessibleLabel: "Initial label" },
    }));

    await value.started.promise;
    await flushAsyncWork();
    expect(host.firstChild?.style.height).toBe("30px");
    expect(host.firstChild?.style.width).toBe("60px");

    lifecycle.update?.({
      value,
      options: { height: 18, accessibleLabel: "Updated label" },
    });

    expect(client.mount).toHaveBeenCalledOnce();
    expect(host.firstChild?.style.height).toBe("18px");
    expect(host.firstChild?.style.width).toBe("36px");
    expect(host.firstChild?.getAttribute("aria-label")).toBe("Updated label");
    expect(value.consumed).toBe(true);

    lifecycle.destroy?.();
    controller.dispose();
  });

  it("reports a false mount for a current render-only value", async () => {
    const value = renderValue("consumed");
    value.consumed = true;
    const client = fakeRenderClient();
    const controller = await readyController([client]);
    const onError = vi.fn();
    const lifecycle = requireActionLifecycle(createVallumRenderAction(controller)(asElement(fakeHost()), {
      value,
      onError,
    }));

    await value.started.promise;
    await flushAsyncWork();
    expect(onError).toHaveBeenCalledOnce();
    expect(onError.mock.calls[0]?.[0]).toMatchObject({
      message: "Vallum render-only value could not be mounted",
    });

    lifecycle.destroy?.();
    controller.dispose();
  });
});

interface ActionLifecycle {
  update?(parameters: VallumRenderActionParameters): void;
  destroy?(): void;
}

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
}

interface RenderValue {
  readonly renderOnly: true;
  readonly id: string;
  readonly started: Deferred<void>;
  readonly gate?: Deferred<void>;
  consumed: boolean;
}

interface FakeCanvas {
  readonly id: string;
  parentNode: FakeHost | null;
  readonly style: { height: string; width: string };
  getAttribute(name: string): string | null;
  setAttribute(name: string, value: string): void;
}

interface FakeHost {
  firstChild: FakeCanvas | null;
  readonly ownerDocument: { readonly defaultView: { readonly CustomEvent: typeof CustomEvent } };
  replaceChildren(...children: FakeCanvas[]): void;
  removeChild(child: ChildNode): ChildNode;
  dispatchEvent(event: Event): boolean;
}

type FakeClient = VallumClient & {
  readonly mount: ReturnType<typeof vi.fn>;
  readonly destroy: ReturnType<typeof vi.fn>;
};

async function readyController(clients: FakeClient[]) {
  let index = 0;
  const controller = createVallumController(
    { endpoint: "https://app.example", autoStart: false },
    {
      createClient: async () => {
        const client = clients[index++];
        if (!client) throw new Error("test client queue exhausted");
        return client;
      },
      isBrowser: () => true,
    },
  );
  await controller.initialize();
  return controller;
}

function fakeRenderClient(): FakeClient {
  const destroy = vi.fn();
  const mount = vi.fn(async (
    element: Element,
    candidate: unknown,
    options: MountOptions | undefined,
  ): Promise<boolean> => {
    const value = candidate as RenderValue;
    value.started.resolve();
    if (value.gate) await value.gate.promise;
    if (options?.signal?.aborted) throw options.signal.reason;
    if (value.consumed) return false;
    value.consumed = true;
    (element as unknown as FakeHost).replaceChildren(fakeCanvas(value.id));
    return true;
  });
  return {
    fetch: vi.fn(async () => new Response()),
    wrapFetch: vi.fn((implementation: typeof globalThis.fetch) => implementation),
    renew: vi.fn(async () => undefined),
    mount,
    isRenderOnly: vi.fn((value: unknown) => (
      typeof value === "object" && value !== null && "renderOnly" in value
    )),
    destroy,
    destroyed: false,
  } as unknown as FakeClient;
}

function fakeHost(): FakeHost {
  const CustomEventConstructor = (globalThis.CustomEvent ?? class extends Event {
    readonly detail: unknown;
    constructor(type: string, init?: CustomEventInit) {
      super(type, init);
      this.detail = init?.detail;
    }
  }) as typeof CustomEvent;
  return {
    firstChild: null,
    ownerDocument: { defaultView: { CustomEvent: CustomEventConstructor } },
    replaceChildren(...children): void {
      if (this.firstChild) this.firstChild.parentNode = null;
      this.firstChild = children[0] ?? null;
      if (this.firstChild) this.firstChild.parentNode = this;
    },
    removeChild(child): ChildNode {
      if (this.firstChild !== (child as unknown as FakeCanvas)) {
        throw new Error("attempted to remove a node not owned by the test host");
      }
      this.firstChild.parentNode = null;
      this.firstChild = null;
      return child;
    },
    dispatchEvent: vi.fn(() => true),
  };
}

function fakeCanvas(id: string): FakeCanvas {
  const attributes = new Map<string, string>([
    ["data-vallum-render", ""],
    ["data-vallum-source-width", "200"],
    ["data-vallum-source-height", "100"],
    ["aria-label", "protected value"],
  ]);
  return {
    id,
    parentNode: null,
    style: { height: "50px", width: "100px" },
    getAttribute: (name) => attributes.get(name) ?? null,
    setAttribute: (name, value) => attributes.set(name, value),
  };
}

function renderValue(id: string, slow = false): RenderValue {
  const value: RenderValue = {
    renderOnly: true,
    id,
    started: deferred<void>(),
    consumed: false,
  };
  if (!slow) return value;
  return { ...value, gate: deferred<void>() };
}

function mountSignal(client: FakeClient, call: number): AbortSignal {
  const options = client.mount.mock.calls[call]?.[2] as MountOptions | undefined;
  if (!options?.signal) throw new Error(`mount call ${call} did not receive an AbortSignal`);
  return options.signal;
}

function requireActionLifecycle(lifecycle: void | ActionLifecycle): ActionLifecycle {
  if (!lifecycle) throw new Error("render action did not return a lifecycle");
  return lifecycle;
}

function asElement(host: FakeHost): HTMLElement {
  return host as unknown as HTMLElement;
}

async function flushAsyncWork(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((fulfill) => {
    resolve = fulfill;
  });
  return { promise, resolve };
}
