import { createVallumClient } from "@liteeagle226/client";
import type { VallumClient, VallumClientOptions } from "@liteeagle226/client";

type Subscriber<T> = (value: T) => void;
type Unsubscriber = () => void;

/** The standard Svelte store contract, kept structural for zero runtime cost. */
export interface VallumReadable<T> {
  subscribe(run: Subscriber<T>): Unsubscriber;
}

export type VallumStatus = "idle" | "loading" | "ready" | "error" | "disposed";

export interface VallumState {
  readonly status: VallumStatus;
  readonly ready: boolean;
  readonly client: VallumClient | null;
  readonly error: Error | null;
}

export interface VallumSvelteOptions extends VallumClientOptions {
  /** Start a browser session immediately. Defaults to true in the browser. */
  autoStart?: boolean;
}

export interface VallumController extends VallumReadable<VallumState> {
  /** The current store value, for imperative code. */
  readonly snapshot: VallumState;
  /** Initialize once, sharing work between concurrent callers. */
  initialize(): Promise<VallumClient>;
  /** Establish a fresh client after an error (or rotate a ready client). */
  retry(): Promise<VallumClient>;
  /** A stable protected-fetch function suitable for application API layers. */
  readonly fetch: typeof globalThis.fetch;
  /** Release the client and make this controller permanently unusable. */
  dispose(): void;
}

type VallumClientFactory = (options: VallumClientOptions) => Promise<VallumClient>;

interface ControllerDependencies {
  readonly createClient?: VallumClientFactory;
  readonly isBrowser?: () => boolean;
}

const INITIAL_STATE: VallumState = Object.freeze({
  status: "idle",
  ready: false,
  client: null,
  error: null,
});

/** @internal Exported for focused lifecycle tests, not from the package entry point. */
export function createVallumController(
  options: VallumSvelteOptions,
  dependencies: ControllerDependencies = {},
): VallumController {
  return new BrowserVallumController(options, dependencies);
}

class BrowserVallumController implements VallumController {
  readonly #createClient: VallumClientFactory;
  readonly #isBrowser: () => boolean;
  readonly #clientOptions: VallumClientOptions;
  readonly #subscribers = new Set<Subscriber<VallumState>>();
  #state = INITIAL_STATE;
  #initialization: Promise<VallumClient> | null = null;
  #generation = 0;

  constructor(options: VallumSvelteOptions, dependencies: ControllerDependencies) {
    const { autoStart = true, ...clientOptions } = options;
    this.#clientOptions = clientOptions;
    this.#createClient = dependencies.createClient ?? createVallumClient;
    this.#isBrowser = dependencies.isBrowser ?? isBrowserEnvironment;

    if (autoStart && this.#isBrowser()) {
      void this.initialize().catch(() => {
        // The error is exposed through the store. Avoid an unhandled rejection
        // when initialization was intentionally started in the background.
      });
    }
  }

  get snapshot(): VallumState {
    return this.#state;
  }

  subscribe(run: Subscriber<VallumState>): Unsubscriber {
    this.#subscribers.add(run);
    try {
      run(this.#state);
    } catch (error) {
      this.#subscribers.delete(run);
      throw error;
    }
    return () => {
      this.#subscribers.delete(run);
    };
  }

  initialize(): Promise<VallumClient> {
    if (this.#state.status === "disposed") return Promise.reject(disposedError());
    if (this.#state.client) return Promise.resolve(this.#state.client);
    if (this.#initialization) return this.#initialization;
    if (!this.#isBrowser()) {
      return Promise.reject(new Error(
        "Vallum can only initialize in a browser. Importing and providing it during SSR is supported; call fetch after hydration.",
      ));
    }

    const generation = ++this.#generation;
    this.#publish({ status: "loading", ready: false, client: null, error: null });

    const initialization = Promise.resolve()
      .then(() => this.#createClient(this.#clientOptions))
      .then((client) => {
        if (this.#state.status === "disposed" || generation !== this.#generation) {
          releaseClient(client);
          throw disposedError();
        }
        this.#publish({ status: "ready", ready: true, client, error: null });
        return client;
      })
      .catch((cause: unknown) => {
        const error = normalizeError(cause, "Vallum initialization failed");
        if (this.#state.status !== "disposed" && generation === this.#generation) {
          this.#publish({ status: "error", ready: false, client: null, error });
        }
        throw error;
      })
      .finally(() => {
        if (this.#initialization === initialization) this.#initialization = null;
      });

    this.#initialization = initialization;
    return initialization;
  }

  retry(): Promise<VallumClient> {
    if (this.#state.status === "disposed") return Promise.reject(disposedError());
    if (this.#initialization) return this.#initialization;

    const client = this.#state.client;
    if (client) releaseClient(client);
    this.#publish({ status: "idle", ready: false, client: null, error: null });
    return this.initialize();
  }

  readonly fetch: typeof globalThis.fetch = (input, init) => (
    this.initialize().then((client) => client.fetch(input, init))
  );

  dispose(): void {
    if (this.#state.status === "disposed") return;
    ++this.#generation;
    const client = this.#state.client;
    this.#publish({ status: "disposed", ready: false, client: null, error: null });
    this.#subscribers.clear();
    if (client) releaseClient(client);
  }

  #publish(state: VallumState): void {
    this.#state = Object.freeze(state);
    for (const subscriber of this.#subscribers) {
      try {
        subscriber(this.#state);
      } catch (cause) {
        reportSubscriberError(cause);
      }
    }
  }
}

function reportSubscriberError(cause: unknown): void {
  queueMicrotask(() => {
    const reporter = (globalThis as typeof globalThis & { reportError?: (error: unknown) => void }).reportError;
    if (typeof reporter === "function") {
      reporter(cause);
      return;
    }
    throw cause;
  });
}

function isBrowserEnvironment(): boolean {
  return typeof globalThis.window !== "undefined" && typeof globalThis.document !== "undefined";
}

function releaseClient(client: VallumClient): void {
  // destroy() was added to @liteeagle226/client as part of the framework-adapter
  // lifecycle. The optional check also keeps this adapter compatible with the
  // earliest 0.1 prerelease builds.
  (client as VallumClient & { destroy?: () => void }).destroy?.();
}

function disposedError(): Error {
  return new Error("Vallum controller has been disposed");
}

function normalizeError(cause: unknown, message: string): Error {
  return cause instanceof Error ? cause : new Error(message, { cause });
}
