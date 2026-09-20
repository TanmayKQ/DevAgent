def title_case(s: str) -> str:
    return s.capitalize()


def dedupe(items: list) -> list:
    return list(set(items))


def is_palindrome(s: str) -> bool:
    return s == s[::-1]
