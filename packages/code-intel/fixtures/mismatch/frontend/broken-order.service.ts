import { HttpClient } from "@angular/common/http";
import { Injectable } from "@angular/core";
import { Observable } from "rxjs";
import { BrokenOrderDto } from "./broken-order.model";

@Injectable({ providedIn: "root" })
export class BrokenOrderService {
  constructor(private readonly http: HttpClient) {}

  create(): Observable<BrokenOrderDto> {
    return this.http.post<BrokenOrderDto>("/api/order", { customerName: "x", total: 1 });
  }
}