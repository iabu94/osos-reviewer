namespace Shop.Api.Services;

public class OrderService : IOrderService
{
    private readonly AppDbContext _db;

    public OrderService(AppDbContext db)
    {
        _db = db;
    }

    public Task<IReadOnlyList<OrderDto>> ListAsync()
    {
        throw new NotImplementedException();
    }

    public Task<OrderDto> GetAsync(int id)
    {
        throw new NotImplementedException();
    }

    public Task<OrderDto> CreateAsync(OrderDto dto)
    {
        throw new NotImplementedException();
    }

    public Task DeleteAsync(int id)
    {
        throw new NotImplementedException();
    }

    private void Audit(string message)
    {
    }
}
