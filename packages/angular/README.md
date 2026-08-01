# @wc-bindable/angular

Angular adapter for the **wc-bindable** protocol.

## Install

```bash
npm install @wc-bindable/angular @angular/core
```

## Usage

```typescript
import { Component } from "@angular/core";
import { WcBindableDirective } from "@wc-bindable/angular";

@Component({
  selector: "app-root",
  standalone: true,
  imports: [WcBindableDirective],
  template: `
    <my-input wcBindable (wcBindableChange)="onUpdate($event)" />
    <p>Current value: {{ currentValue }}</p>
  `,
})
export class AppComponent {
  currentValue = "";

  onUpdate(event: { name: string; value: unknown }) {
    if (event.name === "value") {
      this.currentValue = event.value as string;
    }
  }
}
```

## API

### `WcBindableDirective`

A standalone directive applied via the `wcBindable` attribute selector.

| Output | Type | Description |
|---|---|---|
| `wcBindableChange` | `{ name: string; value: unknown }` | Emitted whenever a bindable property changes |

- Binds on `ngOnInit` and cleans up on `ngOnDestroy`.
- If the element does not implement `wc-bindable` — and is not a custom element still waiting for its definition — the directive is a no-op. See [Late-defined elements](#late-defined-elements).

## Design Notes

This directive uses `@Output()` with `EventEmitter` rather than the newer `output()` function API (Angular 17.3+). Reasons:

- **Broader compatibility** — works with Angular 17+ (matching the `peerDependencies` requirement).
- **Testability** — `@Output()` does not require an injection context, so the directive can be instantiated directly in unit tests.
- **Stability** — `EventEmitter` is a long-established, stable Angular API with no deprecation planned.

## Late-defined elements

`bind()` is called with `syncOn: "define"` by default, so an element whose custom element
definition arrives *after* this adapter runs — import-map autoloading, a CDN
`<script type="module">`, a code-split route — still binds once the definition lands. Nothing
has to re-run, and no re-render is needed.

Before this default, a not-yet-upgraded element was skipped permanently and silently: discovery
failed, the adapter returned early, and because the element keeps its identity across upgrade
nothing ever noticed. Opt back into that behavior with `syncOn: "call"`.

```html
<my-input wcBindable [wcBindableSyncOn]="'call'" (wcBindableChange)="onChange($event)"></my-input>
```

See [SPEC.md § Deferring Discovery Until Definition](../../SPEC.md#deferring-discovery-until-definition).

## Specification

The protocol contract this adapter implements lives in [SPEC.md](../../SPEC.md); the optional input/command invocation surface and the remote wire format live in [SPEC-extensions.md](../../SPEC-extensions.md). Runnable conformance vectors are in [CONFORMANCE.md](../../CONFORMANCE.md).

## License

MIT
