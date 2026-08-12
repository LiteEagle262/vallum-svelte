import { getContext, onDestroy, setContext } from "svelte";
import type { MountOptions } from "@liteeagle226/client";
import type { Action } from "svelte/action";
import {
  createVallumController,
  type VallumController,
  type VallumSvelteOptions,
} from "./controller.js";

export type {
  VallumController,
  VallumReadable,
  VallumState,
  VallumStatus,
  VallumSvelteOptions,
} from "./controller.js";

const VALLUM_CONTEXT = Symbol.for("@liteeagle226/svelte/context");

/** Create a readable Vallum lifecycle controller without installing context. */
export function createVallum(options: VallumSvelteOptions): VallumController {
  return createVallumController(options);
}

/**
 * Create and install a controller for the current component subtree.
 * The controller is disposed automatically with the providing component.
 */
export function provideVallum(options: VallumSvelteOptions): VallumController {
  const controller = setVallumContext(createVallum(options));
  onDestroy(() => controller.dispose());
  return controller;
}

/** Install an existing controller in the current component's context. */
export function setVallumContext(controller: VallumController): VallumController {
  setContext(VALLUM_CONTEXT, controller);
  return controller;
}

/** Read the nearest controller. Call during component initialization. */
export function getVallumContext(): VallumController {
  const controller = getContext<VallumController | undefined>(VALLUM_CONTEXT);
  if (!controller) {
    throw new Error("No Vallum controller was found. Call provideVallum() in an ancestor component.");
  }
  return controller;
}

export interface VallumRenderActionParameters {
  readonly value: unknown;
  readonly options?: MountOptions;
  /** Receives asynchronous initialization or painting failures. */
  readonly onError?: (error: Error) => void;
}

/**
 * Build a narrowly scoped action for values configured as render-only.
 * It never writes ordinary values into the DOM.
 */
export function createVallumRenderAction(
  controller: VallumController,
): Action<HTMLElement, VallumRenderActionParameters> {
  return (node, initialParameters) => {
    let generation = 0;
    let destroyed = false;
    let mountedNode: ChildNode | null = null;
    let mountedValue: unknown;
    let mountedClient: VallumController["snapshot"]["client"] = null;
    let pendingValue: unknown;
    let pendingClient: VallumController["snapshot"]["client"] = null;
    let paintController: AbortController | null = null;
    let latestParameters = initialParameters;

    const removeOwnedNode = (): void => {
      if (mountedNode?.parentNode === node) node.removeChild(mountedNode);
      mountedNode = null;
      mountedValue = undefined;
      mountedClient = null;
    };

    const report = (parameters: VallumRenderActionParameters, cause: unknown): void => {
      const error = cause instanceof Error
        ? cause
        : new Error("Vallum could not paint a render-only value", { cause });
      if (parameters.onError) {
        parameters.onError(error);
        return;
      }

      const CustomEventConstructor = node.ownerDocument.defaultView?.CustomEvent;
      if (CustomEventConstructor) {
        node.dispatchEvent(new CustomEventConstructor("vallumrendererror", {
          bubbles: true,
          detail: error,
        }));
      }
    };

    const render = async (
      requestGeneration: number,
      parameters: VallumRenderActionParameters,
      paintController: AbortController,
    ): Promise<void> => {
      if (destroyed || requestGeneration !== generation) return;
      if (parameters.value === null || parameters.value === undefined) {
        removeOwnedNode();
        return;
      }

      let client = controller.snapshot.client;
      if (!client) {
        try {
          client = await controller.initialize();
        } catch (cause) {
          if (!destroyed && requestGeneration === generation) report(parameters, cause);
          return;
        }
      }
      if (destroyed || requestGeneration !== generation) return;

      if (!client.isRenderOnly(parameters.value)) {
        removeOwnedNode();
        return;
      }

      try {
        const currentParameters = Object.is(pendingValue, parameters.value)
          ? latestParameters
          : parameters;
        const combinedSignal = combineAbortSignals(
          paintController.signal,
          currentParameters.options?.signal,
        );
        let mounted: boolean;
        try {
          mounted = await client.mount(node, parameters.value, {
            ...currentParameters.options,
            signal: combinedSignal.signal,
          });
        } finally {
          combinedSignal.dispose();
        }
        if (!mounted) {
          if (!destroyed && requestGeneration === generation && !combinedSignal.signal.aborted) {
            report(latestParameters, new Error("Vallum render-only value could not be mounted"));
          }
          return;
        }

        const renderedNode = node.firstChild;
        if (destroyed || requestGeneration !== generation) {
          if (renderedNode) node.removeChild(renderedNode);
          return;
        }
        mountedNode = renderedNode;
        mountedValue = parameters.value;
        mountedClient = client;
        if (renderedNode && "getAttribute" in renderedNode) {
          applyCanvasPresentation(renderedNode as Element, latestParameters.options);
        }
      } catch (cause) {
        if (!destroyed && requestGeneration === generation) report(latestParameters, cause);
      }
    };

    const schedule = (parameters: VallumRenderActionParameters): void => {
      latestParameters = parameters;
      const scheduledClient = controller.snapshot.client;
      if (
        mountedNode &&
        mountedClient === scheduledClient &&
        Object.is(mountedValue, parameters.value)
      ) {
        if ("getAttribute" in mountedNode) {
          applyCanvasPresentation(mountedNode as Element, parameters.options);
        }
        return;
      }
      if (
        paintController &&
        pendingClient === scheduledClient &&
        Object.is(pendingValue, parameters.value)
      ) return;

      const requestGeneration = ++generation;
      paintController?.abort(new Error("Vallum render generation was replaced"));
      const paint = new AbortController();
      paintController = paint;
      pendingValue = parameters.value;
      pendingClient = scheduledClient;
      // A value change invalidates the old pixels immediately. Never leave a
      // prior protected value visible while initialization or painting waits.
      removeOwnedNode();
      const work = render(requestGeneration, parameters, paint).finally(() => {
        if (paintController === paint) {
          paintController = null;
          pendingValue = undefined;
          pendingClient = null;
        }
      });
      void work.catch(reportAsyncError);
    };

    schedule(initialParameters);
    let observedClient = controller.snapshot.client;
    const unsubscribe = controller.subscribe((state) => {
      if (destroyed) return;
      const clientChanged = state.client !== observedClient;
      observedClient = state.client;

      if (state.status === "disposed") {
        ++generation;
        paintController?.abort(new Error("Vallum controller was disposed"));
        paintController = null;
        pendingValue = undefined;
        pendingClient = null;
        removeOwnedNode();
        return;
      }
      if (!clientChanged) return;

      ++generation;
      paintController?.abort(new Error("Vallum client generation changed"));
      paintController = null;
      pendingValue = undefined;
      pendingClient = null;
      removeOwnedNode();
      if (state.client) schedule(latestParameters);
    });
    return {
      update: schedule,
      destroy(): void {
        destroyed = true;
        unsubscribe();
        ++generation;
        paintController?.abort(new Error("Vallum render action was destroyed"));
        paintController = null;
        pendingValue = undefined;
        pendingClient = null;
        removeOwnedNode();
      },
    };
  };
}

function applyCanvasPresentation(node: Element, options: MountOptions | undefined): void {
  if (node.getAttribute("data-vallum-render") === null) return;
  const sourceWidth = Number(node.getAttribute("data-vallum-source-width"));
  const sourceHeight = Number(node.getAttribute("data-vallum-source-height"));
  if (sourceWidth > 0 && sourceHeight > 0) {
    const cssHeight = options?.height ?? sourceHeight / 2;
    const style = (node as HTMLElement).style;
    style.height = `${cssHeight}px`;
    style.width = `${(sourceWidth / sourceHeight) * cssHeight}px`;
  }
  node.setAttribute("aria-label", options?.accessibleLabel ?? "protected value");
}

function combineAbortSignals(
  lifecycleSignal: AbortSignal,
  externalSignal: AbortSignal | undefined,
): { readonly signal: AbortSignal; dispose(): void } {
  if (!externalSignal || externalSignal === lifecycleSignal) {
    return { signal: lifecycleSignal, dispose() {} };
  }

  const controller = new AbortController();
  const listeners: Array<{ signal: AbortSignal; abort: () => void }> = [];
  for (const signal of [lifecycleSignal, externalSignal]) {
    const abort = (): void => {
      if (!controller.signal.aborted) controller.abort(signal.reason);
    };
    if (signal.aborted) {
      abort();
      break;
    }
    signal.addEventListener("abort", abort, { once: true });
    listeners.push({ signal, abort });
  }

  return {
    signal: controller.signal,
    dispose(): void {
      for (const listener of listeners) {
        listener.signal.removeEventListener("abort", listener.abort);
      }
    },
  };
}

function reportAsyncError(cause: unknown): void {
  queueMicrotask(() => {
    const reporter = (globalThis as typeof globalThis & { reportError?: (error: unknown) => void }).reportError;
    if (typeof reporter === "function") reporter(cause);
    else throw cause;
  });
}
