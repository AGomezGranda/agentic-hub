# DDD

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

# ✅ the aggregate protects its own invariant
class Order:
    items: list[Item]
    status: OrderStatus

    def add_item(self, item):
        if self.status is not OrderStatus.OPEN:
            raise OrderClosed(self.status)
        self.items.append(item)
```
Consequence: a second call site that appends to `order.items` directly (a
batch job, a migration script) breaks the "no items after shipped" rule
with no compiler or runtime complaint, because nothing but convention
enforced it.

## Bounded context leak

```python
# ❌ billing reaches into shipping's internal row shape directly
shipment = db.query("select * from shipping.shipments where order_id = ?", id)
if shipment.carrier_internal_status_code == 7: ...

# ✅ billing depends on shipping's published interface
status = shipping_client.get_shipment_status(order_id)
if status is ShipmentStatus.DELIVERED: ...
```
Consequence: shipping renumbers its internal status codes in a refactor
that never touches its public API, and billing breaks anyway because it
was never entitled to see that column.
