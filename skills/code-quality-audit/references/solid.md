# SOLID

SRP: a class/function changing for more than one reason. OCP: new cases
requiring edits to existing branches instead of extension. LSP: a subtype
that narrows preconditions or breaks a caller's expectation of the base
type. ISP: callers forced to implement/depend on methods they don't use.
DIP: high-level logic importing/constructing a concrete low-level
dependency directly instead of depending on an abstraction it owns.

## SRP

```python
# ❌ prices an order AND formats it for email — a pricing-rule change and
# an email-template change now share a diff
class OrderService:
    def total(self, order): ...
    def send_confirmation_email(self, order): ...

# ✅ split by reason to change
class OrderPricer:
    def total(self, order): ...

class OrderNotifier:
    def send_confirmation_email(self, order): ...
```
Consequence: a pricing bugfix PR now touches email-sending code, and a
reviewer who owns pricing has to read templating logic to approve it.

## DIP — severity depends on whether the dependency will ever change

```python
# ❌ high-level policy constructs its own low-level dependency
class PriceCalculator:
    def __init__(self):
        self.db = PostgresConnection()  # can't test without a real DB

# ✅ depends on an abstraction it owns
class PriceCalculator:
    def __init__(self, prices: PriceRepository):
        self.prices = prices
```
Consequence: without the seam, every `PriceCalculator` test needs a real
database. But **not every DIP violation is a finding**: a one-off script
that constructs `PostgresConnection()` directly, with no second
implementation and no test needing a double, has nothing wrong with it —
report it only when it blocks a concrete test double or a real second
implementation, not because the textbook shape is missing.

## ISP

```python
# ❌ one interface forces every implementer to carry printing too
class Worker(Protocol):
    def process(self, job): ...
    def print_report(self, job): ...

# ✅ split so a background worker isn't forced to implement printing
class Processor(Protocol):
    def process(self, job): ...

class Reporter(Protocol):
    def print_report(self, job): ...
```
Consequence: a headless worker either raises `NotImplementedError` on
`print_report` or grows a fake implementation nobody calls — both are dead
weight callers now have to route around.
