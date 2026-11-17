using Microsoft.AspNetCore.Mvc;

namespace Shop.Api.Controllers;

[ApiController]
[Route("api/orders")]
public class OrdersController : ControllerBase
{
    private readonly IOrderService _orders;

    public OrdersController(IOrderService orders)
    {
        _orders = orders;
    }

    [HttpGet]
    public async Task<ActionResult<IReadOnlyList<OrderDto>>> List()
    {
        return Ok(await _orders.ListAsync());
    }

    [HttpGet("{id:int}")]
    public async Task<ActionResult<OrderDto>> Get(int id)
    {
        return Ok(await _orders.GetAsync(id));
    }

    [HttpPost]
    public async Task<ActionResult<OrderDto>> Create([FromBody] OrderDto dto)
    {
        return Ok(await _orders.CreateAsync(dto));
    }

    [HttpDelete("{id:int}")]
    public async Task<IActionResult> Delete(int id)
    {
        await _orders.DeleteAsync(id);
        return NoContent();
    }
}
