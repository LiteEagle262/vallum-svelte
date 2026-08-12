# `@liteeagle226/svelte`

Svelte 5 bindings for `@liteeagle226/client`. The package provides a readable
lifecycle controller, component context helpers, a stable protected-fetch
function, and an opt-in action for render-only values.

The module is safe to import during SSR. It does not touch `window`, start a
session, or mutate the DOM at module evaluation time. A provided controller
stays `idle` on the server and starts after browser hydration.

## Install

```sh
npm install @liteeagle226/client @liteeagle226/svelte svelte
```

`@liteeagle226/svelte` supports Svelte 5. Your application still needs the
same-origin, authenticated admission broker required by `@liteeagle226/client`.

## Provide once

Call `provideVallum` during component initialization in a root component or
layout. It installs context and disposes the browser client when that provider
is destroyed.

```svelte
<script lang="ts">
  import { provideVallum } from "@liteeagle226/svelte";

  let { children } = $props();

  provideVallum({
    endpoint: "https://app.example.com",
  });
</script>

{@render children()}
```

Consume the controller from a descendant. It implements the Svelte readable
store contract, so `$vallum` is reactive.

```svelte
<script lang="ts">
  import { getVallumContext } from "@liteeagle226/svelte";

  const vallum = getVallumContext();

  async function loadAccount() {
    const response = await vallum.fetch("/api/private/account");
    return response.json();
  }
</script>

{#if $vallum.status === "loading"}
  <p>Establishing a protected session…</p>
{:else if $vallum.error}
  <button onclick={() => vallum.retry()}>Retry</button>
{/if}
```

`vallum.fetch` is stable and can be passed directly to an API layer. It never
patches global `fetch`. `initialize()` shares concurrent work; `retry()` creates
a fresh client; `dispose()` is permanent. Use `createVallum()` instead of
`provideVallum()` when you want to own disposal outside component context.

Set `autoStart: false` to initialize only on the first `initialize()` or
`fetch()` call.

## Render-only fields

Render-only fields returned by Vallum are pixel references, not strings. Mount
them into an explicitly selected host with the action factory:

```svelte
<script lang="ts">
  import {
    createVallumRenderAction,
    getVallumContext,
  } from "@liteeagle226/svelte";

  let { protectedValue } = $props();
  const vallum = getVallumContext();
  const renderOnly = createVallumRenderAction(vallum);
</script>

<span
  use:renderOnly={{
    value: protectedValue,
    options: { height: 20 },
    onError: (error) => console.error(error),
  }}
></span>
```

The action never renders ordinary values. It starts the latest paint
immediately, aborts superseded work before one-shot pixels are consumed, clears
its canvas when the controller retries or is disposed, and ignores late work
after teardown. Supplying
`options.accessibleLabel` intentionally exposes that label to the accessibility
tree; without one, the client uses a generic “protected value” label.

## SSR and security boundaries

- Importing, creating, and providing are SSR-safe; protected fetches are
  browser-only and reject clearly before hydration.
- Do not put an admission signing key, decoded response, or long-lived secret
  in Svelte state, page data, or the browser bundle.
- This adapter does not weaken or replace application authentication,
  authorization, CSRF controls, admission budgets, or the SDK's same-origin
  requirements.
- Render-only output raises extraction cost but remains observable by a user or
  software that can inspect or capture the rendered page.

## Package checks

```sh
npm run build -w @liteeagle226/svelte
npm run test -w @liteeagle226/svelte
npm pack -w @liteeagle226/svelte --dry-run
```
