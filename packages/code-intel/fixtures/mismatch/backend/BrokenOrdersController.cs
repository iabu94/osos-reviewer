using Microsoft.AspNetCore.Mvc;

namespace Shop.Api.Controllers;

[ApiController]
[Route("api/orders")]
public class BrokenOrdersController : ControllerBase
{
    [HttpGet]
    public async Task<ActionResult<IReadOnlyList<BrokenOrderDto>>> List()
    {
        return Ok(Array.Empty<BrokenOrderDto>());
    }
}