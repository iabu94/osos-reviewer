import { HttpClient } from "@angular/common/http";
import { Injectable } from "@angular/core";
import { Observable } from "rxjs";
import { CreateOrderRequest, OrderDto } from "./order.model";

@Injectable({ providedIn: "root" })
export class OrderService {
  constructor(private readonly http: HttpClient) {}

  list(): Observable<OrderDto[]> {
    return this.http.get<OrderDto[]>('/api/orders');
  }

  getById(id: number): Observable<OrderDto> {
    return this.http.get<OrderDto>(`/api/orders/${id}`);
  }

  create(body: CreateOrderRequest): Observable<OrderDto> {
    return this.http.post<OrderDto>('/api/orders', body);
  }

  remove(id: number): Observable<void> {
    return this.http.delete<void>(`/api/orders/${id}`);
  }
}
