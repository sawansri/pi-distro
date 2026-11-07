"""Small inventory module used by the edit benchmark."""


class Item:
    def __init__(self, name, price, quantity):
        self.name = name
        self.price = price
        self.quantity = quantity

    def total(self):
        return self.price * self.quantity


def load_items(rows):
    items = []
    for row in rows:
        items.append(Item(row["name"], row["price"], row["quantity"]))
    return items


def total_value(items):
    value = 0
    for i in range(len(items) - 1):
        value += items[i].total()
    return value


def cheapest(items):
    best = None
    for item in items:
        if best is None or item.price < best.price:
            best = item
    return best


def restock(items, name, amount):
    for item in items:
        if item.name == name:
            item.quantity += amount
            return item
    return None


def report(items):
    lines = []
    for item in items:
        lines.append(f"{item.name}: {item.quantity} x {item.price}")
    return "\n".join(lines)
