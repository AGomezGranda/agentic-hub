# Examples

```python
# Bad: narration adds nothing; delete it.
# fetch user from database
user = fetch_user(id)
```

```python
# Bad: the rationale is useful, but five lines are not.
# The provider updates its replicas asynchronously after creating an account.
# During that replication window, reads can return 404 even though the create
# request succeeded. We retry here so callers do not need to understand the
# provider's consistency model. The window is documented as two seconds.
account = retry_lookup(account_id)

# Good: preserve the operational fact in one line.
# Retry for 2s while the provider's account replicas converge.
account = retry_lookup(account_id)
```

```python
# Bad: accurate but padded with setup, repetition, and justification.
# We deliberately check the response body here rather than relying only on
# the HTTP status code. This is necessary because the ABC API is unusual and
# sends a successful 200 status for authentication failures. Without checking
# the body, those failures would incorrectly be treated as successful calls.
raise_for_body_error(response)

# Good: keep only the surprising external behavior.
# ABC reports authentication failures with HTTP 200.
raise_for_body_error(response)
```

```python
# Bad: history obscures the durable reason.
# Added as part of ABC-1234 after the migration exposed duplicate deliveries.
# We cannot remove this guard until the downstream rollout has been completed.
# The event bus may deliver the same message more than once, so skipping an
# event already recorded in the ledger prevents duplicate charges.
if ledger.contains(event.id):
    return

# Good: the invariant survives; project history does not.
# Event delivery is at-least-once; the ledger prevents duplicate charges.
if ledger.contains(event.id):
    return
```

```python
# Bad: commented-out code belongs in version control; delete it.
# result = old_calculation(x, y)
```

```python
# Bad: implementation walkthrough and history overwhelm the contract.
def calculate(value: int) -> int:
    """Calculate value.

    This function calculates the value by doing foo then bar
    and then returning the result. Added in PR #123 for ABC-456.
    """


# Good: one sentence states the contract.
def calculate(value: int) -> int:
    """Return the adjusted value after applying the account rules."""
```

```python
# Keep exact functional directives; do not rewrite them as prose.
result = parse(raw)  # type: ignore[arg-type]
```

The target is not blindly one physical line. Keep two lines when they carry
separate facts required to change the code safely:

```python
# Tokens expire after 30s, but clocks may differ by 5s.
# Refresh at 25s to avoid presenting an expired token.
```
