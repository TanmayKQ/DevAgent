from src.mathutils import gcd


def test_gcd_basic():
    assert gcd(12, 8) == 4


def test_gcd_coprime():
    assert gcd(7, 13) == 1
