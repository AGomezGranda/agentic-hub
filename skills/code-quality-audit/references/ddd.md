# DDD

Check procedure: identify the business invariant and its owner before judging
shape. Evidence needed: the invariant statement, the aggregate root guarding
it, and the call sites that must go through the root.

Apply where business invariants and ownership justify it, even without a
folder called domain. Do not demand rich entities for simple CRUD — a data
row with no invariant needs no aggregate.

Only where a domain layer exists. Anemic models (all data,
getters/setters, logic lives in services instead of the entity), logic
that belongs in the domain leaking into controllers/handlers, a bounded
context's internals (types, IDs) crossing into another context instead of
going through its published interface, an aggregate whose invariants can
be broken by reaching through it instead of its root.

## Anemic model

```python
# ❌ Order is a bag of fields; the invariant lives in a service — one of
# many places it could be skipped
class Order:
    items: list[Item]
    status: str


class OrderService:
    def add_item(self, order, item):
        order.items.append(item)  # nothing stops this after status="shipped"


# ✅ the aggregate protects its own invariant: internal storage, immutable
# external views, guarded transitions (see tests/fixtures/skill_examples/ddd_order.py)
class Order:
    def __init__(self) -> None:
        self._items: list[str] = []
        self._status: str = "OPEN"

    def add_item(self, item: str) -> None:
        if self._status != "OPEN":
            raise OrderClosed(self._status)
        self._items.append(item)

    def close(self) -> None:
        self._status = "CLOSED"

    @property
    def items(self) -> tuple[str, ...]:
        return tuple(self._items)
```
Consequence: a second call site that appends to `order.items` directly (a
batch job, a migration script) breaks the "no items after shipped" rule
with no compiler or runtime complaint, because nothing but convention
enforced it. Correction: keep `_items` private, expose a `tuple` copy, guard
`add_item` on status — callers cannot bypass the invariant through the
public API since no mutable accessor exists.

Non-finding: simple CRUD with no cross-field invariant — a dataclass with
public fields and no guards is correct, not anemic.

## Bounded context leak

```python
# ❌ billing reaches into shipping's internal row shape directly
shipment = db.query("select * from shipping.shipments where order_id = ?", id)
if shipment.carrier_internal_status_code == 7:
    ...

# ✅ billing depends on shipping's published interface
status = shipping_client.get_shipment_status(order_id)
if status is ShipmentStatus.DELIVERED:
    ...
```
Consequence: shipping renumbers its internal status codes in a refactor
that never touches its public API, and billing breaks anyway because it
was never entitled to see that column. Correction: go through the published
interface.
