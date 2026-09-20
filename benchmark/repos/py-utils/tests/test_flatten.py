from src.mathutils import flatten


def test_flatten_nested_lists():
    assert flatten([1, [2, 3], [4, [5, 6]]]) == [1, 2, 3, 4, 5, 6]


def test_flatten_already_flat():
    assert flatten([1, 2, 3]) == [1, 2, 3]
