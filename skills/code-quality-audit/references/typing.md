# Typing

Check procedure: separate unsafe type escape (`any`, unchecked cast, missing
narrowing) from valid boundary narrowing (validated input refined to a precise
type). Evidence needed: the escape's path:line, what invalid state it admits,
and the caller-visible failure it permits.

Check argument identity (wrong-typed argument still type-checks), variant
coverage (all union members handled), optional states (`None`/missing handled
or explicitly excluded), and validation at input boundaries.

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
Correction: introduce the nominal type. Note: nominal types do not validate
arbitrary runtime input — validate untrusted strings at the boundary, then
wrap.

Non-finding: validating boundary narrowing — `UserId(raw)` after an explicit
format check — is the correct use, not an escape.

## Missing exhaustiveness check

```python
# ❌ a new variant silently falls through to the default branch
def handle(event: Event):
    if event.kind == "created":
        ...
    elif event.kind == "updated":
        ...
    else:
        log.warning("unknown event")  # "deleted" lands here forever


# ✅ explicit union plus assert_never; adding a variant is a type error
Event = Created | Updated | Deleted


def handle(event: Event) -> str:
    if isinstance(event, Created):
        return "created"
    elif isinstance(event, Updated):
        return "updated"
    elif isinstance(event, Deleted):
        return "deleted"
    else:
        assert_never(event)
        raise AssertionError("unreachable")
```
Consequence: someone adds a `Deleted` variant, every other switch over
`Event.kind` keeps compiling, and the gap ships silently instead of as a
build failure at every site that needs updating. Correction: use the
union + `assert_never` shape above (see
`tests/fixtures/skill_examples/typing_valid.py`); an extended union without
a new branch fails the checker at `assert_never` with `bad-argument-type`.
Configure the checker for exhaustiveness (this repo: pyrefly default preset
flags `assert_never` misuse) rather than relying on a bare `else: log`.
