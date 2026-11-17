export interface OrderDto {
  id: number;
  customerName: string;
  total: number;
}

export interface CreateOrderRequest {
  customerName: string;
  items: number[];
}
