# Boundaries — who may talk to whom?

Check procedure: start from the declared rules (ADRs, import contracts) and
the target standard (`standard.md`, L and S5); never adopt the dominant
direction in the import graph as the rule.
Then check every module-level edge against it. Evidence needed: the edge
(`a → b`, count), one importing `path:line` with verbatim excerpt, the rule
it breaks (declared `file:line` or standard rule ID; "N of M modules do
this" is scope, not a defence),
and the change or test that the edge makes harder.

Check, in order:

1. **Dependency direction** — policy/domain depends on infrastructure
   (ORM, HTTP client, framework, message broker) instead of the reverse.
2. **Cycles** — module-level import cycles, including ones hidden behind
   function-local or `TYPE_CHECKING` imports.
3. **Reaching into internals** — imports of another module's private
   submodules, underscore names, or tables instead of its public surface
   (`__init__`, `index.ts`, published client, API).
4. **Leaky contracts** — a boundary's public signature exposes the other
   side's types: ORM rows, HTTP response objects, vendor exceptions, raw
   config dicts crossing into the domain.
5. **Bounded-context leaks** — one context reads another's storage or
   internal IDs/status codes instead of its published interface.

## Dependency direction

```python
# ❌ domain/pricing.py — policy imports the ORM and the session
from app.db.models import PriceRow
from app.db.session import session


def price_for(sku: str) -> Decimal:
    return session.query(PriceRow).filter_by(sku=sku).one().amount
```
Consequence: every pricing change and test needs a database, and swapping
storage edits the domain. Correction: the domain declares the port it needs
(`PriceRepository` protocol in `domain/`), infrastructure implements it —
the edge flips to `db → domain`.

Non-finding: a script or CLI tool classified as such (standard.md,
Applicability) whose entry point talks to storage directly. A CRUD service
still gets layers (L): its handlers call a use case, not the ORM.

## Cycle

```text
orders → billing   (orders/checkout.py:12  from billing import invoice_for)
billing → orders   (billing/invoice.py:4   from orders.models import Order)
```
Consequence: neither module can be understood, tested, or extracted alone;
an edit on either side can break import order at startup. Correction: move
the shared type to the side that owns it and have the other depend one way,
or invert one edge with an event/callback the owner publishes.

A `TYPE_CHECKING`-only import for annotations, where runtime code has no
cycle, is still L5: report it at P2, since the types still couple both sides.

## Reaching into internals

Cross-context imports past the package root are always S5 findings. Within
a context, a module with no declared surface (everything importable,
callers pick arbitrary internals) is a finding only when the graph shows callers actually
reaching into internals *and* that blocks a concrete change. A module that
merely lacks an `__all__` is not.

## Leaky contract

```python
# ❌ the repository port returns the ORM row and raises the driver's error
class OrderRepository(Protocol):
    def get(self, id: str) -> OrderRow: ...  # raises psycopg.OperationalError
```
Consequence: callers in the domain now import `OrderRow` and catch driver
exceptions — the port exists but the dependency still flows through it.
Correction: the port speaks domain types and domain errors
(`Order`, `OrderNotFound`); the adapter translates.

Non-finding: framework types at the *edge* where they belong — a FastAPI
handler taking a `Request`, a CLI command taking `click.Context`.

## Bounded-context leak (T6, S5)

```python
# ❌ billing reads shipping's internal table and status codes
shipment = db.query("select * from shipping.shipments where order_id = ?", id)
if shipment.carrier_internal_status_code == 7:
    ...

# ✅ billing depends on shipping's published interface
status = shipping_client.get_shipment_status(order_id)
if status is ShipmentStatus.DELIVERED:
    ...
```
Consequence: shipping renumbers its internal codes without touching its
public API, and billing breaks anyway. Correction: go through the published
interface; if none exists, that's the finding — shipping needs one.
