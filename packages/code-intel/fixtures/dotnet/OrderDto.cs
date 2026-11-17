namespace Shop.Api.Models;

public record OrderDto(int Id, string CustomerId, decimal Total);

public class OrderSummaryDto
{
    public int Id { get; set; }
    public string Status { get; set; } = "";
}
