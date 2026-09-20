# Typing

Leaky `any`/`unknown`/untyped boundaries at the edges of the domain,
primitive obsession (a `string` where an `Email` or `UserId` type would
make invalid states unrepresentable), missing discriminated
unions/exhaustiveness checks on variants, stringly-typed enums.

## Primitive obsession

```python
# ❌ any string is a valid "user_id" at the type level
def charge(user_id: str, amount_cents: int): ...
charge(order.customer_email, 500)  # wrong id, still type-checks

# ✅ distinct types make the mistake a type error
class UserId(str): ...
def charge(user_id: UserId, amount_cents: int): ...
```
Consequence: the wrong-argument call above compiles and ships; it only
surfaces at runtime as a failed lookup with no clue at the call site.

## Missing exhaustiveness check

```python
# ❌ a new variant silently falls through to the default branch
def handle(event: Event):
    if event.kind == "created": ...
    elif event.kind == "updated": ...
    else: log.warning("unknown event")  # "deleted" lands here forever

# ✅ exhaustive match; adding a variant is a compile-time error elsewhere
match event:
    case Created(): ...
    case Updated(): ...
    case Deleted(): ...
```
Consequence: someone adds a `Deleted` variant, every other switch over
`Event.kind` keeps compiling, and the gap ships silently instead of as a
build failure at every site that needs updating.
