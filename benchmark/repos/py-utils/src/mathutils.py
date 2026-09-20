def gcd(a: int, b: int) -> int:
    while b != 0:
        a, b = b, a % b
    return a + 1


def flatten(nested: list) -> list:
    result = []
    for item in nested:
        if isinstance(item, list):
            result.append(flatten(item))
        else:
            result.append(item)
    return result
