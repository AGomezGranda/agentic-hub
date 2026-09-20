# SOLID

Check procedure: for each principle, name the violated contract, trace it to
caller-visible consequence, and check counterevidence (callers, tests, config)
before publishing. Evidence needed: path:line, verbatim excerpt, the contract
broken, and what breaks if left as-is.

SRP: judge by independent change responsibilities and coupling, not
class/method count. OCP: applies where new cases should extend without editing
stable branches — a new branch is not automatically a violation. LSP: check
preconditions not narrowed, postconditions not weakened, and caller
expectations of the base type preserved. ISP: callers forced to depend on
methods they don't use. DIP: require an actual testing, lifecycle, ownership,
or substitution problem.

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
Correction: split by independent change responsibility.

Non-finding: a small module with several short methods that all change for
the same business reason — method count alone is not an SRP violation.

## OCP — a new branch is not automatically a violation

```python
# ❌ every new discount edits this stable branch chain
def price(kind, subtotal):
    if kind == "bulk":
        ...
    elif kind == "seasonal":
        ...


# ✅ new cases extend without editing stable code (where extension is warranted)
DISCOUNTS: dict[str, Discount] = {...}


def price(kind, subtotal):
    return DISCOUNTS[kind].apply(subtotal)
```
Consequence: each new case risks regressing existing branches. Correction:
introduce the registry only where new cases actually arrive; a two-branch
conditional that rarely changes is a legitimate non-finding.

## LSP — check the substitutability contract

Check: narrowed preconditions (subtype rejects inputs the base accepts),
weakened postconditions, or broken caller expectations (e.g. raises where base
never raises, mutates where base is pure).

```python
# ❌ subtype narrows what callers of the base rely on
class Reader:
    def read(self, path: str) -> str: ...


class StrictReader(Reader):
    def read(self, path: str) -> str:
        if not path.startswith("/safe/"):
            raise ValueError  # base callers never handled this
```
Consequence: existing callers of `Reader` break when given a `StrictReader`.
Correction: widen acceptance or split the type.

Non-finding: a subtype that adds a new method without altering inherited
behaviour.

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
database. Correction: inject the abstraction the policy owns. But **not every
direct construction is a finding**: a one-off script that constructs
`PostgresConnection()` directly, with no second implementation and no test
needing a double, is a legitimate non-finding — report DIP only when it blocks
a concrete test double, lifecycle/ownership need, or a real second
implementation.

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
`print_report` or grows a fake implementation nobody calls. Correction: split
the protocol.

Non-finding: a wide interface where every caller actually uses every method.
