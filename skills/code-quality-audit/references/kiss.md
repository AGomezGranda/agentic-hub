# KISS

The wrong abstraction, not too much abstraction (that's `ponytail-review`'s
job). A wrapper that doesn't match the problem shape, a generic solution
for one concrete case, control flow that's hard to trace because it's
modeling the wrong thing.

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
nobody asked for.

## Wrong-shape wrapper

```python
# ❌ wraps a dict to "hide" it, but every call site still needs dict semantics
class ConfigWrapper:
    def __init__(self, d): self._d = d
    def get(self, k): return self._d.get(k)
    def keys(self): return self._d.keys()
    def items(self): return self._d.items()

# ✅ it's a dict; use one
config: dict[str, str] = load_config()
```
Consequence: the wrapper adds an indirection layer with none of a real
abstraction's benefits — no invariant it protects, no behaviour it
changes — so every caller pays a hop to reach plain dict semantics anyway.
