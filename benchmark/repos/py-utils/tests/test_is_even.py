from src.mathutils import is_even


def test_is_even_true_for_even_numbers():
    assert is_even(4) is True
    assert is_even(0) is True


def test_is_even_false_for_odd_numbers():
    assert is_even(3) is False
    assert is_even(-1) is False
