# Responsibilities — who should own what?

Check procedure: for each concept in scope, name its owner (the module that
decides its rules and mutates its state), then look for rules and writes
living elsewhere. Use the co-change table to find non-local change: a pair of
modules that repeatedly change together is a lead, not a verdict — open a few
of those commits and name the shared reason to change. Evidence needed: the
misplaced rule or write (`path:line`, verbatim), its rightful owner, and
either the co-change count or a concrete change scenario that would have to
touch both.

Check, in order:

1. **Business-logic placement** — rules in controllers/handlers, jobs, SQL,
   or UI instead of the module that owns the concept.
2. **Invariant ownership** — an invariant that can be bypassed because state
   is mutable from outside its owner (anemic model, public collections,
   direct writes to another module's tables).
3. **Data/state ownership** — two modules writing the same table, cache key,
   or global; nobody clearly the source of truth.
4. **Change locality** — one business change routinely touching many
   modules (shotgun surgery), per co-change table and sampled commits.
5. **God modules** — a `common`/`utils`/`core`/`shared` package or service
   that most features edit and everything imports; cohesion judged by
   independent reasons to change, not size.

## Anemic model / bypassable invariant

```python
# ❌ the invariant lives in a service — one of many places it can be skipped
class Order:
    items: list[Item]
    status: str

class OrderService:
    def add_item(self, order, item):
        order.items.append(item)  # nothing stops this after status="shipped"

# ✅ the aggregate guards its own invariant; no mutable accessor escapes
class Order:
    def __init__(self) -> None:
        self._items: list[Item] = []
        self._status = "OPEN"

    def add_item(self, item: Item) -> None:
        if self._status != "OPEN":
            raise OrderClosed(self._status)
        self._items.append(item)

    @property
    def items(self) -> tuple[Item, ...]:
        return tuple(self._items)
```
Consequence: a batch job appending to `order.items` directly breaks "no
items after shipping" with no complaint. Correction: private state, guarded
transitions, immutable views.

Non-finding: CRUD data with no cross-field invariant — a dataclass with
public fields and no guards is correct, not anemic.

## Logic in the wrong layer

```python
# ❌ api/orders.py — the discount rule lives in the HTTP handler
@router.post("/orders")
def create(body: OrderIn):
    total = sum(i.price for i in body.items)
    if body.customer_tier == "gold" and total > 100:
        total *= Decimal("0.9")
```
Consequence: the CLI import and the nightly re-pricing job reimplement (or
skip) the rule; three copies drift. Correction: move the rule to the pricing
module; the handler calls it. Distinct from DRY in `code-quality-audit`: the
defect is *where* the rule lives, not that it's repeated.

## Shared ownership of state

```text
orders/repo.py:40     UPDATE orders SET status = 'PAID' ...
billing/webhook.py:88 UPDATE orders SET status = 'PAID', paid_at = ...
```
Consequence: two writers, two definitions of "paid"; a status-transition
rule added in `orders` is silently bypassed by the webhook. Correction: one
owner writes; the other asks it (call, command, or event).

## Change locality / god module

Evidence shape: `shared/ co-changed with 14 of 18 feature modules; 61% of
its commits also touch another module; sampled a1b2c3, d4e5f6: both add a
field to shared/models.py for one feature`. Correction: move each concept
into the feature that owns it; keep in `shared/` only what changes for no
single feature's reason.

Non-finding: a stable shared kernel (IDs, money type, clock) that many
modules import but that rarely changes — high fan-in with low churn is
healthy. Co-change between a module and its own tests or its adapter is
expected, not a locality problem.

## Abstraction quality

An abstraction at a module seam is a finding only when it hides the wrong
thing — callers still need its internals (leaks, see boundaries) or it
bundles concepts that change for different reasons. "Unneeded abstraction"
is over-engineering: route to `ponytail-review`/`ponytail-audit`.
