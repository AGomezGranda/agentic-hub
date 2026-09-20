# KISS

Check procedure: name the unnecessary indirection or speculative abstraction,
list its current consumers, and state which protected invariant (if any) it
guards. Evidence needed: the abstraction's path:line, its call sites, and the
simpler shape that preserves behaviour.

Own unnecessary indirection and speculative abstraction directly here — do not
route the finding elsewhere. Before proposing deletion, check current consumers
and protected invariants.

## Generic solution for one concrete case

```python
# ❌ a plugin registry for a choice that's had one option in two years
class DiscountStrategyRegistry:
    _strategies: dict[str, DiscountStrategy] = {}

    def register(self, name, strategy): ...
    def get(self, name): ...


# ✅ the one rule that actually exists
def bulk_discount(subtotal, items):
    return subtotal * 0.9 if items > 10 else subtotal
```
Consequence: every reader traces a registry lookup to find the one rule
that's ever been registered, and the "plugin" shape invites a second one
nobody asked for. Correction: inline the one rule; reintroduce the registry
when a second case actually arrives.

## Wrong-shape wrapper

```python
# ❌ wraps a dict to "hide" it, but every call site still needs dict semantics
class ConfigWrapper:
    def __init__(self, d):
        self._d = d

    def get(self, k):
        return self._d.get(k)

    def keys(self):
        return self._d.keys()

    def items(self):
        return self._d.items()


# ✅ it's a dict; use one
config: dict[str, str] = load_config()
```
Consequence: the wrapper adds an indirection layer with none of a real
abstraction's benefits — no invariant it protects, no behaviour it
changes — so every caller pays a hop to reach plain dict semantics anyway.
Correction: use the dict directly.

Non-finding: a useful adapter with one implementation that protects an
invariant or decouples callers from a volatile dependency remains valid —
single implementation alone is not a deletion warrant.
