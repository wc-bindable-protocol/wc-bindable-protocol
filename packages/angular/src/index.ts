import {
  Directive,
  ElementRef,
  EventEmitter,
  OnInit,
  OnDestroy,
  Output,
} from "@angular/core";
import { bind, isWcBindable } from "@wc-bindable/core";

@Directive({
  selector: "[wcBindable]",
  standalone: true,
})
export class WcBindableDirective implements OnInit, OnDestroy {
  @Output() wcBindableChange = new EventEmitter<{ name: string; value: unknown }>();

  private unbind?: () => void;

  constructor(private el: ElementRef<HTMLElement>) {}

  ngOnInit() {
    const element = this.el.nativeElement;
    if (!isWcBindable(element)) return;

    this.unbind = bind(element, (name, value) => {
      this.wcBindableChange.emit({ name, value });
    });
  }

  ngOnDestroy() {
    this.unbind?.();
  }
}
