# Calibration examples

One finding (❌), its correction (✅) and a non-finding per rule. Rule IDs
refer to the architecture-audit standard. Examples calibrate judgement;
they are not an exhaustive checklist.

## L1 — domain imports no framework, ORM or I/O

```python
# ❌ domain/order.py
from sqlalchemy.orm import Session
class Order:
    def confirm(self, session: Session): ...
# ✅ the use case loads/saves via an OrderRepository port; Order.confirm()
#    only changes state and records an OrderConfirmed event.
```
Non-finding: domain importing `dataclasses`, `decimal`, or the shared
kernel's `Money`.

## L2 — use cases orchestrate, they hold no business rule

```python
# ❌ application/approve_trade.py
if trade.notional > client.limit: raise LimitExceeded()
# ✅ client.approve(trade) raises LimitExceeded; the use case loads, calls, saves.
```
Non-finding: a use case branching on a port's result (not found → 404 error).

## L3 — ports speak domain types

```python
# ❌ def get(self, id) -> sqlalchemy.Row     raises psycopg.OperationalError
# ✅ def get(self, id: OrderId) -> Order     raises OrderNotFound / RepositoryUnavailable
```

## L4 — inbound adapters are thin

❌ An HTTP handler that queries the ORM and computes fees. ✅ Parse → command
→ one use case → map result. Non-finding: framework types (Request, Pydantic
models) inside the handler.

## T1 — one owner per invariant, no escaping mutable state

```python
# ❌ order.lines.append(line)   # bypasses the max-lines / total checks
# ✅ order.add_line(line)       # checks, then mutates a private list
```
Non-finding: a plain DTO with public fields where no invariant exists.

## T2 — reference other aggregates by ID

❌ `Order.customer: Customer` loaded and mutated in the same transaction.
✅ `Order.customer_id: CustomerId`; cross-aggregate effects via events.

## T3 — value objects for concepts with rules or units

```python
# ❌ def charge(user_id: str, amount: float, currency: str)
#    charge(order.customer_email, 9.99, "usd")   # type-checks, wrong id, float money
# ✅ def charge(user_id: UserId, amount: Money)
```
Non-finding: a `str` for free text with no rule (a note, a display label).
Wrapping a validated string (`UserId(raw)` after a format check) is correct
narrowing, not an unsafe cast.

## T5 — ubiquitous language

❌ `TradeDataProcessor.handle()` when tickets say "settle a trade". ✅
`SettleTrade` use case, `Trade.settle()`. Non-finding: technical names for
genuinely technical pieces (`RetryPolicy`, `HttpClient`).

## T6 — contexts integrate via published interfaces

❌ pricing imports `payments.adapters.db.models.PaymentRow`. ✅ pricing calls
the payments client / consumes `PaymentSettled`, translated at its ACL.

## D1/D3 — inject side-effecting collaborators

```python
# ❌ class SettleTrade:
#        def __init__(self, gateway=None):
#            self.gateway = gateway or BankGateway(os.environ["BANK_URL"])
#        def __call__(self, ...): now = datetime.now() ...
# ✅ def __init__(self, gateway: BankGateway, clock: Clock)  # built in main.py
```
Non-finding: constructing a value object or calling a pure helper directly;
a script's `main()` building its own client.

## D4 — narrowest capability

❌ `def __init__(self, settings: Settings)` to read one timeout. ✅
`def __init__(self, timeout: timedelta)`.

## D5 / KISS — no interface over pure logic

❌ `FeeCalculatorProtocol` + `FeeCalculatorImpl` for a pure function with one
implementation. ✅ a function. Non-finding: a port with one adapter (the seam
exists for tests and lifecycle).

## S2/S3 — package by context, no junk drawers

❌ `services/`, `models/`, `utils/helpers.py` spanning every feature; a fee
change touches four top-level folders. ✅ `pricing/{domain,application,adapters}`.
Non-finding: a single-context service with layers at the top level.

## SRP / DRY

❌ `OrderService.total()` and `.send_confirmation_email()` — pricing and
email templates change for different reasons. ❌ the same eligibility rule in
two handlers that must change together. Non-finding: several short methods
changing for one reason; similar-looking code implementing independent rules.

## Errors

❌ `except Exception: log.warning(...); return True` — caller sees success
after failure. ✅ let it propagate, or return an explicit failure result.
Non-finding: a broad catch at a worker loop boundary that logs, marks the
job failed and continues.

## E1 — lock it in

For every checkable L/S/D gap, propose the concrete contract, e.g.:

```ini
# .importlinter
[importlinter:contract:pricing-layers]
name = pricing layers
type = layers
layers = pricing.adapters | pricing.application | pricing.domain
```

```js
// .dependency-cruiser.cjs (TypeScript)
{ name: "domain-no-adapters", severity: "error",
  from: { path: "^src/[^/]+/domain" }, to: { path: "^src/[^/]+/adapters" } }
```
