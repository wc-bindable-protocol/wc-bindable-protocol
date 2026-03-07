# @wc-bindable/angular

Angular adapter for the **wc-bindable** protocol.

## Install

```bash
npm install @wc-bindable/angular @wc-bindable/core
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
- If the element does not implement `wc-bindable`, the directive is a no-op.

## License

MIT
