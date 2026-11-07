SETTINGS = {
    "retries": 3,
    "timeout": 30,
    "region": "us-east",
}

LIMITS = [
    ("small", 10, 100),
    ("medium", 10, 500),
    ("large", 10, 1000),
    ("xlarge", 10, 5000),
]


def limit_for(size):
    for name, low, high in LIMITS:
        if name == size:
            return low, high
    return None


def describe(size):
    bounds = limit_for(size)
    if bounds is None:
        return "unknown"
    low, high = bounds
    if high > 1000:
        return "big"
    return "normal"
