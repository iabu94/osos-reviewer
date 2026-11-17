import { Component, Input, Output, EventEmitter, inject, signal, input, output } from "@angular/core";
import { OrderService } from "./order.service";
import { OrderDto } from "./order.model";

@Component({
  selector: "app-order-list",
  template: `<ul></ul>`,
})
export class OrderListComponent {
  private readonly orderService = inject(OrderService);

  @Input() customerId!: number;
  @Output() selected = new EventEmitter<OrderDto>();

  readonly orders = signal<OrderDto[]>([]);
  readonly pageSize = input(10);
  readonly refreshed = output<void>();

  constructor(private readonly legacyService: OrderService) {}

  load(): void {
    this.orderService.list().subscribe((o) => this.orders.set(o));
  }
}
