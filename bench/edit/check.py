"""Checks one benchmark task in a work directory: python3 -I check.py <task> <dir>."""
import importlib.util, sys

task, workdir = sys.argv[1], sys.argv[2]

def load(name):
    spec = importlib.util.spec_from_file_location(name, f"{workdir}/{name}.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module

inv = load("inventory")
cfg = load("config")
items = inv.load_items([{"name": "a", "price": 2, "quantity": 3}, {"name": "b", "price": 5, "quantity": 1}])

def check():
    if task == "offbyone":
        return inv.total_value(items) == 11
    if task == "param":
        return inv.report(items) == "a: 3 x 2 USD\nb: 1 x 5 USD" and inv.report(items, currency="EUR").endswith("EUR")
    if task == "nearDup":
        return cfg.LIMITS == [("small", 10, 100), ("medium", 10, 500), ("large", 50, 1000), ("xlarge", 10, 5000)]
    if task == "elif":
        return cfg.describe("xlarge") == "huge" and cfg.describe("large") == "normal" and cfg.describe("x") == "unknown"
    if task == "rename":
        return hasattr(inv, "cheapest_item") and not hasattr(inv, "cheapest") and inv.cheapest_item(items).name == "a"
    if task == "multi":
        try:
            inv.restock(items, "a", 0)
            return False
        except ValueError as e:
            if str(e) != "amount must be positive":
                return False
        rows = [{"name": "z", "price": 1, "quantity": 0}, {"name": "y", "price": 1, "quantity": 2}]
        return [i.name for i in inv.load_items(rows)] == ["y"] and inv.restock(items, "a", 2).quantity == 5
    raise SystemExit(f"unknown task {task}")

try:
    ok = check()
except Exception as e:
    print(f"error: {e!r}")
    ok = False
print("PASS" if ok else "FAIL")
