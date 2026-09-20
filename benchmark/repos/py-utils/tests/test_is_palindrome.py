from src.strutils import is_palindrome


def test_is_palindrome_ignores_case_and_spaces():
    assert is_palindrome("A man a plan a canal Panama") is True


def test_is_palindrome_rejects_non_palindrome():
    assert is_palindrome("hello") is False
