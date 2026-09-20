# Examples

```python
# ❌ narration — remove
# fetch user from database
user = fetch_user(id)

# ✅ keep — non-obvious constraint
# ABC API returns 200 on auth failure; check body.error
```

```python
# ❌ history — shorten to durable reason
# TODO(ABC-1234): remove once migration finishes
# Retry on 409 — ABC system is eventually consistent for 2s after POST

# ✅
# Retry on 409 — ABC system is eventually consistent for 2s after POST
```

```python
# ❌ commented-out code — remove
# result = old_calculation(x, y)

# ❌ verbose docstring — trim to contract
def calculate(value: int) -> int:
    """Calculate value.

    This function calculates the value by doing foo then bar
    and then returning the result. Added in PR #123 for ABC-456.
    """


# ✅
def calculate(value: int) -> int:
    """Return adjusted calculation result."""
```
