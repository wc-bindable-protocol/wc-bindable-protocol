import {
  Directive,
  ElementRef,
  EventEmitter,
  Input,
  OnInit,
  OnDestroy,
  Output,
} from "@angular/core";
import { bind, type BindOptions } from "@wc-bindable/core";

@Directive({
  selector: "[wcBindable]",
  standalone: true,
})
export class WcBindableDirective implements OnInit, OnDestroy {
  @Output() wcBindableChange = new EventEmitter<{ name: string; value: unknown }>();

  /**
   * Forwarded to `bind()`. Defaults to `"define"` so an element whose
   * definition arrives after `ngOnInit` still binds — see SPEC.md
   * § Deferring Discovery Until Definition. Set `"call"` to opt back into
   * the historical behavior, where a not-yet-upgraded element is skipped
   * permanently.
   */
  @Input() wcBindableSyncOn?: BindOptions["syncOn"];

  private unbind?: () => void;

  constructor(private el: ElementRef<HTMLElement>) {}

  ngOnInit() {
    const element = this.el.nativeElement;

    // No `isWcBindable()` gate: bind() already returns a no-op cleanup for
    // a non-bindable target, and the gate is precisely what defeated
    // `syncOn: "define"` — it fails for a not-yet-upgraded custom element,
    // and ngOnInit does not run again to notice the upgrade.
    this.unbind = bind(element, (name, value) => {
      this.wcBindableChange.emit({ name, value });
    }, { syncOn: this.wcBindableSyncOn ?? "define" });
  }

  ngOnDestroy() {
    this.unbind?.();
  }
}
