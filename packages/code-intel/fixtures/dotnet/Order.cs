using System.ComponentModel.DataAnnotations;

namespace Shop.Domain;

public class Order
{
    [Key]
    public int Id { get; set; }

    public string CustomerId { get; set; } = "";

    public decimal Total { get; set; }
}
