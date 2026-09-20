# DRY

Duplication that will *drift* (the same business rule expressed twice, will
silently diverge) vs. incidental repetition (two unrelated things that
happen to look similar today). Only the first is a finding; flagging the
second creates a false coupling when someone "fixes" it.

## Will drift — a finding

```python
# ❌ the discount rule is written twice; a rate change fixes one, misses the other
def checkout_total(cart):
    return cart.subtotal * 0.9 if cart.items > 10 else cart.subtotal

def invoice_total(order):
    return order.subtotal * 0.9 if order.items > 10 else order.subtotal

# ✅ one rule, two callers
def bulk_discount(subtotal, items):
    return subtotal * 0.9 if items > 10 else subtotal
```
Consequence: marketing changes the bulk discount to 15%; whoever edits it
finds `checkout_total`, ships it, and `invoice_total` silently keeps
charging the old rate.

## Incidental — not a finding

```python
# looks identical today, but for unrelated reasons
def validate_username(s): return len(s) <= 20
def validate_tag(s): return len(s) <= 20
```
Consequence of "fixing" this: extracting a shared `validate_length_20`
couples a length change to two rules that have no reason to move together
— the next time either limit changes, it becomes a judgment call whether
the shared helper still applies to both.
