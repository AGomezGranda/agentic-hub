# Error handling

Check procedure: trace each failure to the caller-visible outcome — what the
caller observes (return value, raised error, log only, success reported).
Evidence needed: the handling site's path:line, the swallowed/lost context,
and the false signal the caller acts on.

Swallowed exceptions, catch-and-log-and-continue where the caller needed to
know, errors that lose type/context crossing a module boundary, broad
`catch`/`except` hiding a specific failure a caller could handle
differently, success reported after failure.

## Swallowed exception

```python
# ❌ caller has no idea the write failed
def save(order):
    try:
        db.write(order)
    except Exception as e:
        log.error(e)


# ✅ caller decides what to do with the failure
def save(order):
    db.write(order)  # raises; caller catches what it can handle
```
Consequence: an order silently fails to persist; the log line nobody is
watching is the only record, and the caller reports success anyway.
Correction: let it raise, or return an explicit failure the caller checks.

## Broad catch hiding a specific failure

```python
# ❌ a timeout and a 4xx get the same treatment
try:
    response = client.get(url)
except Exception:
    return cached_value()

# ✅ a caller can retry a timeout and can't retry a 404
try:
    response = client.get(url)
except TimeoutError:
    return cached_value()
except HTTPStatusError as e:
    if e.status == 404:
        raise NotFound(url) from e
    raise
```
Consequence: a permanent 404 gets silently masked as "using cached
value", so a real data problem looks identical to a transient network
blip in every log and every alert. Correction: narrow the catch, preserve
context with `raise ... from`.

Non-finding: broad exception handling at a deliberate process/task boundary
(top-level worker loop, request handler) is legitimate when the outcome
remains truthful — the error is recorded with context, the task is marked
failed/retried, and no caller is told it succeeded.
